import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// 実装ソースと、テスト専用の作業ログを保持する。
const coreSource = await readFile(new URL("../extension/core.js", import.meta.url), "utf8");
const backgroundSource = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const entry = { identifier: "test-entry", taskIdentifier: "test-task", title: "外部サイトへ出してはいけない作業名", startAt: "2026-09-05T00:00:00Z", endAt: null };

function createEvent() {
  // Chromeイベントの登録先と発火機能を用意する。
  const listeners = [];
  return {
    addListener(listener) {
      // イベントに登録された処理を保持する。
      listeners.push(listener);
    },
    emit(...argumentsList) {
      // 登録された処理へ引数を順番に渡す。
      return listeners.map(function invokeListener(listener) {
        // 各イベントハンドラーを呼び出す。
        return listener(...argumentsList);
      });
    }
  };
}

function createStorage(initial = {}) {
  // Chromeの保存領域を、コピー可能なメモリ内ストレージで再現する。
  return {
    values: structuredClone(initial),
    async get(key) {
      // 指定されたキーの保存値を返す。
      return { [key]: structuredClone(this.values[key]) };
    },
    async set(values) {
      // 保存内容を参照が共有されない状態で保持する。
      Object.assign(this.values, structuredClone(values));
    },
    async setAccessLevel() {
      // テストでは保存領域のアクセス設定だけを受け付ける。
    }
  };
}

async function createHarness(savedSession = {}, savedLocal = {}) {
  // 実際の背景スクリプトを、時刻とChrome APIを制御できる環境で起動する。
  const control = {
    timestamp: 100000,
    responseBody: JSON.stringify(entry),
    fetchFailure: false,
    fetchStatus: 200,
    focused: true,
    idleState: "active",
    tab: { id: 7, url: "https://www.youtube.com/watch?v=test" },
    requests: [],
    deliveries: [],
    badge: "",
    alarm: null,
    grantedOrigins: new Set(),
    scripts: [],
    injections: []
  };
  const chrome = {
    storage: { local: createStorage(savedLocal), session: createStorage(savedSession) },
    runtime: {
      id: "test-extension", onMessage: createEvent(), onConnect: createEvent(), onInstalled: createEvent(), onStartup: createEvent(),
      getURL(path) {
        // テスト用の拡張オリジンへ変換する。
        return `chrome-extension://test-extension/${path}`;
      }
    },
    alarms: {
      onAlarm: createEvent(),
      async get() {
        // 登録済みのアラームを返す。
        return control.alarm;
      },
      async create(name, options) {
        // 定期アラームの設定を記録する。
        control.alarm = { name, ...options };
      }
    },
    windows: {
      onFocusChanged: createEvent(),
      async getLastFocused() {
        // 前面状態を任意に切り替えられるウィンドウを返す。
        return { id: 1, focused: control.focused, state: "normal" };
      }
    },
    idle: {
      onStateChanged: createEvent(),
      async queryState() {
        // 入力待ちと画面ロックを個別に再現する。
        return control.idleState;
      }
    },
    tabs: {
      onActivated: createEvent(), onUpdated: createEvent(), onRemoved: createEvent(),
      async query(options = {}) {
        // 現在選択されているタブだけを返す。
        if (options.url && !options.url.some(function matchesQueriedSite(pattern) {
          // 対象ドメインを指定した問い合わせでは、該当するタブだけを返す。
          const domain = pattern.replace("*://*.", "").replace("/*", "");
          const hostname = new URL(control.tab.url).hostname;
          return hostname === domain || hostname.endsWith(`.${domain}`);
        })) return [];
        return [{ ...control.tab }];
      },
      async sendMessage(tabIdentifier, message) {
        // Webページに渡した情報を検査用に記録する。
        control.deliveries.push({ tabIdentifier, message: structuredClone(message) });
      }
    },
    permissions: {
      onAdded: createEvent(), onRemoved: createEvent(),
      async contains({ origins }) {
        // テストで付与したドメインの権限だけを返す。
        return origins.every(function isGranted(origin) {
          // 要求されたホスト権限を確認する。
          return control.grantedOrigins.has(origin);
        });
      },
      async remove({ origins }) {
        // 削除したサイトのホスト権限を解除する。
        for (const origin of origins) control.grantedOrigins.delete(origin);
        return true;
      }
    },
    scripting: {
      async getRegisteredContentScripts() {
        // 保存済みの動的スクリプトを返す。
        return structuredClone(control.scripts);
      },
      async registerContentScripts(scripts) {
        // サイト追加時の永続登録を記録する。
        control.scripts = structuredClone(scripts);
      },
      async updateContentScripts(scripts) {
        // 既存の動的スクリプトの対象変更を記録する。
        control.scripts = structuredClone(scripts);
      },
      async unregisterContentScripts() {
        // 動的スクリプトの登録を解除する。
        control.scripts = [];
      },
      async executeScript(details) {
        // すでに開いているタブへの適用を記録する。
        control.injections.push(structuredClone(details));
      }
    },
    action: {
      async setBadgeText({ text }) {
        // ツールバーのバッジを記録する。
        control.badge = text;
      },
      async setBadgeBackgroundColor() {
        // バッジの色指定を受け付ける。
      },
      async setTitle() {
        // ツールバーのタイトル指定を受け付ける。
      }
    }
  };
  class ControlledDate extends Date {
    static now() {
      // テスト側から指定された現在時刻を返す。
      return control.timestamp;
    }
  }
  const context = vm.createContext({
    chrome, Date: ControlledDate, URL, AbortSignal, console,
    importScripts() {
      // 本物の共通処理をService Workerの実行環境へ読み込む。
      vm.runInContext(coreSource, context);
    },
    async fetch(address, options) {
      // HTTP要求を記録し、指定した本文または接続障害を返す。
      control.requests.push({ address, options });
      if (control.fetchFailure) throw new TypeError("Failed to fetch");
      return {
        ok: control.fetchStatus === 200, status: control.fetchStatus,
        async text() {
          // API本文をそのまま返す。
          return control.responseBody;
        }
      };
    }
  });
  vm.runInContext(backgroundSource, context);

  async function message(payload, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") }) {
    // 実際に登録されたメッセージハンドラーの非同期応答を待つ。
    return new Promise(function waitForResponse(resolve) {
      // Chromeと同じ送信元情報と応答コールバックを渡す。
      chrome.runtime.onMessage.emit(payload, sender, resolve);
    });
  }

  async function step(milliseconds = 5000, payload = { type: "get-snapshot" }) {
    // 時刻を進めて1回の更新を実行する。
    control.timestamp += milliseconds;
    return message(payload);
  }
  function connectPopup(sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") }) {
    // 本物のポップアップと同じ、接続・フォーカス・切断のイベントを作る。
    const port = { name: "focus-monitor-popup", sender, onMessage: createEvent(), onDisconnect: createEvent() };
    chrome.runtime.onConnect.emit(port);
    return port;
  }
  await message({ type: "get-snapshot" });
  return { control, chrome, message, step, connectPopup };
}

test("GET専用・5秒周期・30秒アラームで稼働し、1分でバッジが現れる", async function testPolling() {
  // 実際の背景処理を繰り返し呼び、計測とAPI頻度を検証する。
  const harness = await createHarness();
  await harness.step(1000);
  assert.equal(harness.control.requests.length, 1);
  await harness.step(4000);
  for (let iteration = 0; iteration < 11; iteration += 1) await harness.step();
  assert.equal(harness.control.badge, "1m");
  assert.equal(harness.chrome.storage.session.values.focusMonitorSession.state.balanceMilliseconds, 60000);
  assert.equal(harness.control.alarm.periodInMinutes, 0.5);
  for (const request of harness.control.requests) {
    assert.equal(request.address, "http://127.0.0.1:48120/api/v1/time-entries/active");
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.redirect, "error");
  }
});

test("停止時の実際の空HTTP 200を正しく処理する", async function testEmptyResponse() {
  // JSON解析の失敗によって未接続と誤表示しないことを検証する。
  const harness = await createHarness();
  harness.control.responseBody = "";
  const result = await harness.step();
  assert.equal(result.snapshot.state.connected, true);
  assert.equal(result.snapshot.state.workKey, null);
  assert.equal(result.snapshot.state.mode, "paused");
});

test("ページへ作業名を送らず、ページ側から設定を書き換えられない", async function testMessageBoundary() {
  // コンテンツスクリプトと設定画面の権限境界を検証する。
  const harness = await createHarness();
  const sender = { id: harness.chrome.runtime.id, tab: { id: 7 }, frameId: 0, url: harness.control.tab.url };
  const response = await harness.message({ type: "heartbeat" }, sender);
  assert.equal(response.snapshot.state.workTitle, "");
  assert.equal(response.snapshot.state.workKey, "active");
  assert.equal(JSON.stringify(harness.control.deliveries).includes(entry.title), false);
  const forbidden = await harness.message({ type: "save-settings", settings: { enabled: false } }, sender);
  assert.equal(forbidden.ok, false);
  const current = await harness.message({ type: "get-snapshot" });
  assert.equal(current.snapshot.settings.enabled, true);
});

test("15分除外で減算し、期限経過・解除後に計測へ戻る", async function testExclusion() {
  // タブごとの例外が、残高のリセットや永久停止にならないことを検証する。
  const harness = await createHarness();
  for (let iteration = 0; iteration < 12; iteration += 1) await harness.step();
  let result = await harness.message({ type: "exclude-tab" });
  assert.equal(result.snapshot.state.mode, "recovering");
  result = await harness.step();
  assert.equal(result.snapshot.state.balanceMilliseconds, 55000);
  result = await harness.message({ type: "include-tab" });
  assert.equal(result.snapshot.state.mode, "watching");
  await harness.message({ type: "exclude-tab" });
  result = await harness.step(900000);
  assert.equal(result.snapshot.state.mode, "watching");
  assert.equal(result.snapshot.state.balanceMilliseconds, 0);
});

test("Service Worker再作成後もセッションの残高と除外期限を復元する", async function testWorkerRestart() {
  // グローバル変数を失ってもChromeセッション保存値から復帰することを検証する。
  const first = await createHarness();
  for (let iteration = 0; iteration < 12; iteration += 1) await first.step();
  await first.message({ type: "exclude-tab" });
  const second = await createHarness(first.chrome.storage.session.values);
  const result = await second.message({ type: "get-snapshot" });
  assert.equal(result.snapshot.state.balanceMilliseconds, 60000);
  assert.equal(result.snapshot.state.mode, "recovering");
  assert.ok(result.snapshot.state.exemptUntil > 0);
});

test("動画視聴中の無操作は計測し、ロックでは減算へ切り替える", async function testIdleAndLock() {
  // マウスを動かさない動画視聴をサボり対象から漏らさないことを検証する。
  const harness = await createHarness();
  harness.control.idleState = "idle";
  let result = await harness.step();
  assert.equal(result.snapshot.state.mode, "watching");
  harness.control.idleState = "locked";
  result = await harness.step();
  assert.equal(result.snapshot.state.mode, "recovering");
});

test("接続障害と不正な応答を検出し、バッジで知らせる", async function testNetworkFailure() {
  // 通信失敗時に残高をゼロ扱いせず、復旧を待つことを検証する。
  const harness = await createHarness();
  await harness.step();
  harness.control.fetchFailure = true;
  let result = await harness.step();
  const savedBalance = result.snapshot.state.balanceMilliseconds;
  assert.equal(result.snapshot.state.connected, false);
  assert.equal(harness.control.badge, "!");
  result = await harness.step(60000);
  assert.equal(result.snapshot.state.balanceMilliseconds, savedBalance);
  harness.control.fetchFailure = false;
  harness.control.responseBody = "{}";
  result = await harness.step();
  assert.equal(result.snapshot.state.connected, false);
});

test("Twitter上のポップアップへフォーカスが移っても計測を減算しない", async function testPopupFocusRegression() {
  // Chrome本体のfocusedがfalseになるケースで、元のTwitterタブの加算を維持する。
  const harness = await createHarness();
  harness.control.tab.url = "https://x.com/home";
  await harness.step();
  const port = harness.connectPopup();
  harness.control.focused = false;
  let previousBalance = 0;
  for (let seconds = 0; seconds < 8; seconds += 1) {
    port.onMessage.emit({ windowIdentifier: 1, focused: true });
    const result = await harness.step(1000);
    assert.equal(result.snapshot.state.mode, "watching");
    assert.equal(result.snapshot.state.activeSite, "X / Twitter");
    assert.ok(result.snapshot.state.balanceMilliseconds > previousBalance);
    previousBalance = result.snapshot.state.balanceMilliseconds;
  }
  port.onDisconnect.emit();
  await harness.message({ type: "get-snapshot" });
  const closed = await harness.step(1000);
  assert.equal(closed.snapshot.state.mode, "recovering");
  assert.ok(closed.snapshot.state.balanceMilliseconds < previousBalance);
});

test("別アプリへ移ったポップアップ・古い接続・別ウィンドウは前面扱いしない", async function testPopupFocusBoundaries() {
  // 単にポップアップが開いているだけで、バックグラウンド視聴を加算しないことを検証する。
  const harness = await createHarness();
  const port = harness.connectPopup();
  harness.control.focused = false;
  for (const focus of [{ windowIdentifier: 1, focused: false }, { windowIdentifier: 2, focused: true }]) {
    port.onMessage.emit(focus);
    assert.equal((await harness.step(1000)).snapshot.state.mode, "recovering");
  }
  port.onMessage.emit({ windowIdentifier: 1, focused: true });
  await harness.message({ type: "get-snapshot" });
  assert.equal((await harness.step(3000)).snapshot.state.mode, "recovering");
  port.onMessage.emit({ windowIdentifier: 1, focused: true });
  harness.control.tab.url = "https://example.com/work";
  assert.equal((await harness.step(1000)).snapshot.state.mode, "recovering");
});

test("通常タブで開いた設定画面や外部サイトからの接続を前面判定に使わない", async function testPopupSenderValidation() {
  // 正当なポップアップ以外の送信元が、フォーカスを偽装できないことを検証する。
  for (const sender of [
    { id: "test-extension", url: "chrome-extension://test-extension/popup.html", tab: { id: 4 } },
    { id: "test-extension", url: "https://x.com/home", tab: { id: 7 } }
  ]) {
    const harness = await createHarness();
    harness.control.focused = false;
    harness.connectPopup(sender).onMessage.emit({ windowIdentifier: 1, focused: true });
    assert.equal((await harness.step(1000)).snapshot.state.mode, "recovering");
  }
});

test("追加サイトの許可を確認し、既存タブと次回読み込みへ適用する", async function testCustomSiteRegistration() {
  // 許可前には登録せず、許可後に限定したホストだけを計測することを検証する。
  const harness = await createHarness();
  harness.control.tab.url = "https://www.example.com/feed";
  assert.equal((await harness.message({ type: "add-site", site: "example.com" })).ok, false);
  harness.control.grantedOrigins.add("*://*.example.com/*");
  const result = await harness.message({ type: "add-site", site: "https://www.example.com/feed" });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.state.mode, "watching");
  assert.equal(result.snapshot.state.activeSite, "example.com");
  assert.equal(harness.control.scripts[0].persistAcrossSessions, true);
  assert.deepEqual(harness.control.scripts[0].matches, ["*://*.example.com/*"]);
  assert.equal(harness.control.injections[0].target.tabId, 7);
  assert.deepEqual(harness.chrome.storage.local.values.settings.customSites, ["example.com"]);
  const sender = { id: "test-extension", tab: { id: 7 }, frameId: 0, url: harness.control.tab.url };
  assert.equal((await harness.message({ type: "heartbeat" }, sender)).ok, true);
});

test("サイト削除とChrome側の権限解除を計測へ反映する", async function testCustomSiteRemoval() {
  // 削除後は再読み込み前のタブでも表示と計測を停止することを検証する。
  const harness = await createHarness();
  harness.control.tab.url = "https://example.com/feed";
  harness.control.grantedOrigins.add("*://*.example.com/*");
  await harness.message({ type: "add-site", site: "example.com" });
  const result = await harness.message({ type: "remove-site", site: "example.com" });
  assert.equal(result.snapshot.state.mode, "recovering");
  assert.equal(harness.control.grantedOrigins.size, 0);
  assert.equal(harness.control.scripts.length, 0);
  assert.ok(harness.control.deliveries.some(function wasDeactivated(delivery) {
    // 既存のページへ終了メッセージを送ったことを確認する。
    return delivery.message.type === "deactivate";
  }));
  const sender = { id: "test-extension", tab: { id: 7 }, frameId: 0, url: harness.control.tab.url };
  assert.equal((await harness.message({ type: "heartbeat" }, sender)).deactivate, true);
  harness.control.grantedOrigins.add("*://*.example.com/*");
  await harness.message({ type: "add-site", site: "example.com" });
  harness.control.grantedOrigins.clear();
  harness.chrome.permissions.onRemoved.emit({ origins: ["*://*.example.com/*"] });
  const revoked = await harness.message({ type: "get-snapshot" });
  assert.equal(revoked.snapshot.state.mode, "recovering");
  assert.deepEqual(Array.from(revoked.snapshot.sitesNeedingPermission), ["example.com"]);
});

test("通常設定の保存からサイト登録の権限確認を迂回できない", async function testSiteSettingsBoundary() {
  // サイト登録は専用操作でだけ行い、文字サイズの設定とは分離する。
  const harness = await createHarness();
  const result = await harness.message({ type: "save-settings", settings: { timerSizePixels: 96, customSites: ["example.com"] } });
  assert.equal(result.snapshot.settings.timerSizePixels, 96);
  assert.equal(result.snapshot.settings.customSites.length, 0);
});

test("表示開始と移動開始の設定を別々に保存し、背景処理の再起動後も復元する", async function testTimingSettingsPersistence() {
  // ポップアップの保存操作から永続化・再読込・ページへの配信まで確認する。
  const harness = await createHarness({}, { settings: { thresholdSeconds: 90, timerSizePixels: 96 } });
  const previous = await harness.message({ type: "get-snapshot" });
  assert.equal(previous.snapshot.settings.bounceThresholdSeconds, 300);
  await harness.message({ type: "save-settings", settings: { thresholdSeconds: 30, bounceThresholdSeconds: 120 } });
  const restarted = await createHarness({}, harness.chrome.storage.local.values);
  const restored = await restarted.message({ type: "get-snapshot" });
  assert.equal(restored.snapshot.settings.thresholdSeconds, 30);
  assert.equal(restored.snapshot.settings.bounceThresholdSeconds, 120);
  assert.equal(restored.snapshot.settings.timerSizePixels, 96);
  assert.ok(restarted.control.deliveries.some(function includesConfiguredBounceTime(delivery) {
    // ページ内のタイマーにも保存した移動開始時間が届くことを確認する。
    return delivery.message.type === "snapshot" && delivery.message.snapshot.settings.bounceThresholdSeconds === 120;
  }));
});
