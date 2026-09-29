import test from "node:test";
import assert from "node:assert/strict";
import "../extension/core.js";

// 共通設定と、実データを使わない作業ログを保持する。
const core = globalThis.FocusMonitorCore;
const settings = core.normalizeSettings();
const sampleEntry = { identifier: "entry-first", taskIdentifier: "task-first", title: "テスト作業", startAt: "2026-09-05T00:00:00Z", endAt: null, voidedAt: null };
const sampleWork = core.parseActiveEntry(JSON.stringify(sampleEntry));

function observe(state, timestamp, changes = {}, preferences = settings) {
  // 任意の時刻と閲覧条件で計測状態を更新する。
  return core.reconcileState(state, {
    timestamp, connected: true, work: sampleWork, checkedAt: timestamp,
    tabIdentifier: 7, site: "YouTube", focused: true, locked: false, exemptUntil: 0,
    ...changes
  }, preferences);
}

function watchFor(seconds) {
  // 5秒ごとの実際の確認間隔を再現して閲覧を継続する。
  let state = observe(core.createState(0), 0);
  for (let elapsedSeconds = 5; elapsedSeconds <= seconds; elapsedSeconds += 5) {
    state = observe(state, elapsedSeconds * 1000);
  }
  return state;
}

test("60秒で表示対象になり、表示値に最初の1分を含める", function testThreshold() {
  // 閾値の直前と到達時の残高を検証する。
  const state = watchFor(55);
  assert.equal(core.advanceState(state, 59999, settings).thresholdReached, false);
  const visible = observe(state, 60000);
  assert.equal(visible.thresholdReached, true);
  assert.equal(visible.balanceMilliseconds, 60000);
  assert.equal(core.formatDuration(visible.balanceMilliseconds), "01:00");
});

test("サイトを離れると減少し、閾値未満でもゼロになるまで表示資格を保つ", function testRecovery() {
  // 閲覧復帰時のちらつきを防ぐラッチと、負数にならない減算を検証する。
  let state = observe(watchFor(90), 90000, { site: null });
  state = observe(state, 130000, { site: null });
  assert.equal(state.balanceMilliseconds, 50000);
  assert.equal(state.thresholdReached, true);
  state = observe(state, 190000, { site: null });
  assert.equal(state.balanceMilliseconds, 0);
  assert.equal(state.thresholdReached, false);
});

test("XとYouTubeを行き来しても時間を合算する", function testSharedBalance() {
  // サイトとタブを変えても同じ作業区間の残高が引き継がれることを検証する。
  const state = observe(watchFor(55), 60000, { tabIdentifier: 8, site: "X / Twitter" });
  assert.equal(state.balanceMilliseconds, 60000);
  assert.equal(state.mode, "watching");
});

test("別アプリ・対象外タブ・画面ロック中は加算せず減少する", function testForegroundConditions() {
  // バックグラウンド再生やロック中に誤加算しないことを検証する。
  for (const changes of [{ focused: false }, { site: null }, { locked: true }, { exemptUntil: 900000 }]) {
    let state = observe(watchFor(60), 60000, changes);
    assert.equal(state.mode, "recovering");
    state = observe(state, 65000, changes);
    assert.equal(state.balanceMilliseconds, 55000);
  }
});

test("減少速度を0.5倍または2倍へ変更できる", function testRecoveryRate() {
  // 経過時間と減少倍率の積が残高へ反映されることを検証する。
  for (const recoveryRate of [0.5, 2]) {
    const preferences = { ...settings, recoveryRate };
    const state = observe(watchFor(60), 60000, { site: null }, preferences);
    assert.equal(observe(state, 70000, { site: null }, preferences).balanceMilliseconds, 60000 - 10000 * recoveryRate);
  }
});

test("作業停止・タスク変更・同じタスクの新しい作業区間で残高をリセットする", function testSessionBoundaries() {
  // 作業区間の境界を越えてサボり時間が持ち越されないことを検証する。
  for (const work of [null, { key: "second-task", title: "別作業" }, core.parseActiveEntry(JSON.stringify({ ...sampleEntry, identifier: "entry-second" }))]) {
    const state = observe(watchFor(60), 65000, { work });
    assert.equal(state.balanceMilliseconds, 0);
    assert.equal(state.thresholdReached, false);
  }
});

test("同じ作業ログのタイトルや開始日時の編集では計測をリセットしない", function testEntryEdits() {
  // UniToDo側の表示内容修正と作業切り替えを区別する。
  const work = core.parseActiveEntry(JSON.stringify({ ...sampleEntry, title: "修正名", startAt: "2026-09-05T01:00:00Z" }));
  const state = observe(watchFor(60), 65000, { work });
  assert.equal(state.balanceMilliseconds, 65000);
  assert.equal(state.workTitle, "修正名");
});

test("通信切断中は残高を保留し、再接続後に同じ作業なら継続する", function testDisconnection() {
  // 切断を作業停止と誤認せず、未確認の時間も加算しないことを検証する。
  let state = observe(watchFor(60), 60000, { connected: false, work: null });
  assert.equal(state.mode, "paused");
  state = observe(state, 180000, { connected: false, work: null });
  assert.equal(state.balanceMilliseconds, 60000);
  state = observe(state, 185000);
  assert.equal(state.balanceMilliseconds, 60000);
  assert.equal(state.mode, "watching");
});

test("モニターOFF中は残高を保留する", function testDisabledMonitor() {
  // OFFを解除するまで時間が増減しないことを検証する。
  const preferences = { ...settings, enabled: false };
  let state = observe(watchFor(60), 60000, {}, preferences);
  state = observe(state, 360000, {}, preferences);
  assert.equal(state.mode, "paused");
  assert.equal(state.balanceMilliseconds, 60000);
});

test("スリープや長い処理休止を閲覧時間へまとめて加算しない", function testSleep() {
  // 5秒周期から大きく外れた1時間の観測空白を切り捨てる。
  const state = observe(watchFor(55), 3655000);
  assert.equal(state.balanceMilliseconds, 55000);
  assert.equal(state.thresholdReached, false);
  assert.equal(observe(state, 3660000).balanceMilliseconds, 60000);
});

test("時計が過去へ戻っても残高が負数にならない", function testClockChange() {
  // システム時計の逆行で誤った減算をしないことを検証する。
  const state = observe(watchFor(60), 10000);
  assert.equal(state.balanceMilliseconds, 60000);
});

test("ドメインの偽装・対象外プロトコル・埋め込み元サイトを対象にしない", function testHostValidation() {
  // ホスト権限と一致するサイトだけを許可する。
  for (const address of ["https://x.com/", "https://twitter.com/home", "https://m.youtube.com/watch?v=test", "https://www.youtube.com/shorts/test"]) {
    assert.notEqual(core.identifySite(address), null);
  }
  for (const address of ["https://notyoutube.com/", "https://youtube.com.evil.test/", "http://x.com/", "https://x.com@evil.test/", "https://example.com/?site=youtube.com", "chrome://newtab", undefined]) {
    assert.equal(core.identifySite(address), null);
  }
  assert.equal(core.identifySite("https://x.com/", { ...settings, monitorSocial: false }), null);
});

test("停止時の空本文とnullを受け入れ、不正なAPI応答を拒否する", function testApiResponses() {
  // 実機で確認した空のHTTP 200と、将来の形式変更を検出する。
  assert.equal(core.parseActiveEntry(""), null);
  assert.equal(core.parseActiveEntry("null"), null);
  assert.equal(core.parseActiveEntry(" \n "), null);
  assert.throws(function rejectHtml() {
    // HTMLのエラーページを作業ログとして扱わない。
    core.parseActiveEntry("<html>error</html>");
  });
  for (const entry of [{}, [], { ...sampleEntry, endAt: "2026-09-05T01:00:00Z" }, { ...sampleEntry, startAt: "invalid" }]) {
    assert.throws(function rejectInvalidEntry() {
      // 必須フィールドや日時が不正な応答を拒否する。
      core.parseActiveEntry(JSON.stringify(entry));
    });
  }
});

test("設定値を検証し、時間を時分秒へ整形する", function testSettingsAndFormatting() {
  // 破損設定でも表示と計算が継続できることを検証する。
  assert.equal(core.normalizeSettings({ thresholdSeconds: -1 }).thresholdSeconds, 10);
  assert.equal(core.normalizeSettings({ thresholdSeconds: "oops" }).thresholdSeconds, 60);
  assert.equal(core.normalizeSettings({ recoveryRate: 999 }).recoveryRate, 1);
  assert.equal(core.formatDuration(-500), "00:00");
  assert.equal(core.formatDuration(3661000), "1:01:01");
});

test("DVD表示の初期設定は5分から動き、5分未満・OFF・動きの低減時は固定する", function testBounceThreshold() {
  // 表示開始の1分と、移動開始の5分を独立した条件として検証する。
  assert.equal(core.shouldBounce(60000, settings), false);
  assert.equal(core.shouldBounce(299999, settings), false);
  assert.equal(core.shouldBounce(300000, settings), true);
  assert.equal(core.shouldBounce(360000, { ...settings, bounceEnabled: false }), false);
  assert.equal(core.shouldBounce(360000, settings, true), false);
});

test("移動開始時間を変えると、その残高に達した時点で動き、下回ると固定する", function testCustomBounceThreshold() {
  // 表示開始とは独立した設定と、到達前後・減算後の境界を検証する。
  const preferences = core.normalizeSettings({ thresholdSeconds: 30, bounceThresholdSeconds: 120 });
  assert.equal(preferences.thresholdSeconds, 30);
  assert.equal(core.shouldBounce(119999, preferences), false);
  assert.equal(core.shouldBounce(120000, preferences), true);
  assert.equal(core.shouldBounce(119000, preferences), false);
  assert.equal(core.shouldBounce(120000, { ...preferences, bounceEnabled: false }), false);
  assert.equal(core.shouldBounce(120000, preferences, true), false);
  const startsWhenShown = core.normalizeSettings({ thresholdSeconds: 60, bounceThresholdSeconds: 10 });
  assert.equal(core.shouldBounce(60000, startsWhenShown), true);
});

test("旧設定の移動開始は300秒を維持し、不正な値を補正する", function testBounceSettingMigration() {
  // 保存項目の追加後も、既存利用者の開始時間と有効な秒数を保証する。
  assert.equal(core.normalizeSettings({ bounceEnabled: false }).bounceThresholdSeconds, 300);
  assert.equal(core.normalizeSettings({ bounceThresholdSeconds: -1 }).bounceThresholdSeconds, 10);
  assert.equal(core.normalizeSettings({ bounceThresholdSeconds: 9999 }).bounceThresholdSeconds, 3600);
  assert.equal(core.normalizeSettings({ bounceThresholdSeconds: "bad" }).bounceThresholdSeconds, 300);
  assert.equal(core.normalizeSettings({ bounceThresholdSeconds: Infinity }).bounceThresholdSeconds, 300);
  assert.equal(core.normalizeSettings({ bounceThresholdSeconds: 120.6 }).bounceThresholdSeconds, 121);
});

test("サイズ設定は16〜160pxで保存し、旧設定でも48pxで表示する", function testTimerSize() {
  // 設定の移行と範囲外入力の補正を検証する。
  assert.equal(core.normalizeSettings({}).timerSizePixels, 48);
  assert.equal(core.normalizeSettings({ timerSizePixels: 96 }).timerSizePixels, 96);
  assert.equal(core.normalizeSettings({ timerSizePixels: 1 }).timerSizePixels, 16);
  assert.equal(core.normalizeSettings({ timerSizePixels: 999 }).timerSizePixels, 160);
  assert.equal(core.normalizeSettings({ timerSizePixels: "bad" }).timerSizePixels, 48);
});

test("登録サイトはURLをドメインへ揃え、HTTP・HTTPSとサブドメインを対象にする", function testCustomSiteMatching() {
  // パスやクエリを保存せず、偽装した別ドメインに一致させないことを検証する。
  const domain = core.normalizeSiteInput("https://www.Example.com/feed?private=discarded#section");
  assert.equal(domain, "example.com");
  const preferences = core.normalizeSettings({ customSites: [domain] });
  assert.equal(core.identifySite("https://example.com/", preferences), domain);
  assert.equal(core.identifySite("http://news.example.com/", preferences), domain);
  assert.equal(core.identifySite("https://example.com.evil.test/", preferences), null);
  assert.equal(core.identifySite("https://notexample.com/", preferences), null);
  assert.equal(core.getSitePattern(domain), "*://*.example.com/*");
});

test("不正なサイト入力と重複登録を受け付けない", function testCustomSiteValidation() {
  // ワイルドカードやローカルAPIへの登録、重なるドメインの登録を拒否する。
  for (const input of ["", "*.example.com", "localhost", "127.0.0.1", "https://example.com:9000", "https://user:secret@example.com", "javascript:alert(1)", "https://-bad.example/", "chrome://extensions", "com"]) {
    assert.throws(function rejectInvalidSite() {
      // 通常のWebドメイン以外を対象にしない。
      core.normalizeSiteInput(input);
    });
  }
  for (const domain of ["x.com", "m.youtube.com", "example.com", "news.example.com"]) {
    assert.throws(function rejectOverlappingSite() {
      // 標準サイトや登録済みサイトと重複しないようにする。
      core.validateNewSite(domain, { ...settings, customSites: ["example.com"] });
    });
  }
});
