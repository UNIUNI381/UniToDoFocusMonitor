// 共通の計測処理をService Workerへ読み込む。
importScripts("core.js");

// API接続先、更新周期、状態保存キーを保持する。
const core = globalThis.FocusMonitorCore;
const activeEntryAddress = "http://127.0.0.1:48120/api/v1/time-entries/active";
const alarmName = "unitodo-focus-refresh";
const pollingInterval = 5000;
const snapshotKey = "focusMonitorSession";

// 現在の設定、計測状態、タブごとの除外期限を保持する。
let settings = core.normalizeSettings();
let state = core.createState();
let exemptions = {};
// APIの最後の確認結果と、直列処理の待ち行列を保持する。
let lastPollAt = 0;
let workResult = { connected: false, work: null, checkedAt: 0, connectionError: "UniToDoへ接続しています。" };
let operationQueue = Promise.resolve();
let initialization;
// 許可がある追加サイトと、現在フォーカスされている拡張ポップアップを保持する。
let permittedCustomSites = [];
let popupPresence = null;
const customScriptIdentifier = "focus-monitor-custom-sites";

async function initialize() {
  // 設定とセッション状態を復元し、休止後に必要なアラームを確保する。
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const [localStorage, sessionStorage] = await Promise.all([
    chrome.storage.local.get("settings"), chrome.storage.session.get(snapshotKey)
  ]);
  settings = core.normalizeSettings(localStorage.settings);
  await synchronizeCustomSites();
  const saved = sessionStorage[snapshotKey];
  if (saved?.version === 1 && Number.isFinite(saved.state?.balanceMilliseconds) &&
      saved.state.balanceMilliseconds >= 0 && Number.isFinite(saved.state.updatedAt)) {
    state = { ...core.createState(), ...saved.state };
    exemptions = saved.exemptions ?? {};
  }
  if (!(await chrome.alarms.get(alarmName))) {
    await chrome.alarms.create(alarmName, { periodInMinutes: 0.5 });
  }
}

async function synchronizeCustomSites() {
  // 権限がある追加サイトだけに、永続的なコンテンツスクリプトを登録する。
  const permissions = await Promise.all(settings.customSites.map(async function checkSitePermission(domain) {
    // 登録ドメインのアクセス権限が実際に付与されているかを確認する。
    return await chrome.permissions.contains({ origins: [core.getSitePattern(domain)] }) ? domain : null;
  }));
  permittedCustomSites = permissions.filter(Boolean);
  const matches = permittedCustomSites.map(core.getSitePattern);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [customScriptIdentifier] });
  if (matches.length === 0) {
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [customScriptIdentifier] });
    return;
  }
  const registration = {
    id: customScriptIdentifier, matches, js: ["core.js", "content.js"],
    runAt: "document_idle", allFrames: false, persistAcrossSessions: true
  };
  if (registered.length) await chrome.scripting.updateContentScripts([registration]);
  else await chrome.scripting.registerContentScripts([registration]);
}

function getTrackingSettings() {
  // サイトの登録情報から、実際に許可された計測対象だけを取り出す。
  return { ...settings, customSites: permittedCustomSites };
}

async function injectOpenSiteTabs(domain) {
  // 追加直後のタブへも表示処理を適用し、ページ再読み込みを不要にする。
  const tabs = await chrome.tabs.query({ url: [core.getSitePattern(domain)] });
  await Promise.all(tabs.map(async function injectIntoTab(tab) {
    // すでに読み込み済みのページでは、内容側のガードで二重起動を防ぐ。
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["core.js", "content.js"] });
    } catch { /* 遷移中のタブには、次のページ読み込み時に自動適用する。 */ }
  }));
}

async function changeCustomSite(message) {
  // ポップアップで許可したサイトを追加・削除し、登録と保存を同期する。
  const domain = core.normalizeSiteInput(message.site);
  const previousSettings = settings;
  if (message.type === "add-site") {
    core.validateNewSite(domain, settings);
    if (!(await chrome.permissions.contains({ origins: [core.getSitePattern(domain)] }))) {
      throw new Error("追加するサイトへのアクセスを許可してください。");
    }
    settings = core.normalizeSettings({ ...settings, customSites: [...settings.customSites, domain] });
  } else {
    if (!settings.customSites.includes(domain)) throw new Error("登録されていないサイトです。");
    settings = core.normalizeSettings({ ...settings, customSites: settings.customSites.filter(function retainOtherSite(registered) {
      // 削除対象以外のサイトを保持する。
      return registered !== domain;
    }) });
  }
  try {
    await synchronizeCustomSites();
    await chrome.storage.local.set({ settings });
  } catch (error) {
    settings = previousSettings;
    await synchronizeCustomSites();
    throw error;
  }
  if (message.type === "add-site") await injectOpenSiteTabs(domain);
  else {
    const tabs = await chrome.tabs.query({ url: [core.getSitePattern(domain)] });
    await Promise.all(tabs.map(function deactivateRemovedSite(tab) {
      // 削除したサイトの既存タブから表示と定期確認を取り除く。
      return sendToTab(tab.id, { type: "deactivate" });
    }));
    await chrome.permissions.remove({ origins: [core.getSitePattern(domain)] });
  }
  return { ok: true, snapshot: await refresh() };
}

function enqueue(operation) {
  // 非同期イベントを直列化し、二重加算や設定保存の競合を防ぐ。
  const pending = operationQueue.then(async function runQueuedOperation() {
    // 起動処理の完了後に要求された操作を実行する。
    initialization ??= initialize();
    await initialization;
    return operation();
  });
  operationQueue = pending.catch(function retainQueueAfterFailure(error) {
    // 失敗後も後続イベントを処理できるようにする。
    console.warn("Focus Monitor:", error.message);
  });
  return pending;
}

async function readWork(timestamp, force) {
  // 固定のローカルAPIだけをGETし、無応答は2.5秒で打ち切る。
  if (!force && timestamp - lastPollAt < pollingInterval) return workResult;
  lastPollAt = timestamp;
  try {
    const response = await fetch(activeEntryAddress, {
      method: "GET", cache: "no-store", credentials: "omit", redirect: "error",
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) throw new Error(`UniToDoからHTTP ${response.status}が返されました。`);
    const work = core.parseActiveEntry(await response.text());
    workResult = { connected: true, work, checkedAt: timestamp, connectionError: "" };
  } catch (error) {
    workResult = {
      connected: false, work: null, checkedAt: timestamp,
      connectionError: error.name === "SyntaxError" ? "UniToDoの応答を読み取れませんでした。" :
        error.message.includes("UniToDo") ? error.message : "UniToDoを起動してください。接続が戻るまで計測を保留します。"
    };
  }
  return workResult;
}

async function readBrowserContext() {
  // ブラウザ本体またはその拡張ポップアップが前面かを確認する。
  try {
    const [browserWindow, idleState] = await Promise.all([
      chrome.windows.getLastFocused({ windowTypes: ["normal"] }), chrome.idle.queryState(60)
    ]);
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: browserWindow.id });
    const popupFocused = popupPresence?.focused === true && popupPresence.windowIdentifier === browserWindow.id &&
      popupPresence.validUntil > Date.now();
    return {
      tabIdentifier: activeTab?.id ?? null,
      site: core.identifySite(activeTab?.url, getTrackingSettings()),
      focused: (browserWindow.focused || popupFocused) && browserWindow.state !== "minimized",
      // 入力がない動画視聴も計測するため、idleではなくlockedだけを除外する。
      locked: idleState === "locked"
    };
  } catch {
    return { tabIdentifier: null, site: null, focused: false, locked: false };
  }
}

function getSnapshot(includeWorkTitle = true) {
  // 表示先へ渡す状態を作り、Webページには作業名と識別子を渡さない。
  const publicState = { ...state };
  if (!includeWorkTitle) {
    publicState.workTitle = "";
    publicState.workKey = state.workKey ? "active" : null;
    publicState.connectionError = "";
  }
  return {
    state: publicState, settings: { ...settings, customSites: includeWorkTitle ? [...settings.customSites] : [] },
    sitesNeedingPermission: includeWorkTitle ? settings.customSites.filter(function needsPermission(domain) {
      // 再許可が必要な登録サイトを、拡張の設定画面だけへ知らせる。
      return !permittedCustomSites.includes(domain);
    }) : [],
    sentAt: Date.now()
  };
}

async function sendToTab(tabIdentifier, message) {
  // 閉じたタブや未読み込みのページへの通知失敗を通常の状態として扱う。
  if (!Number.isInteger(tabIdentifier) || tabIdentifier < 0) return false;
  try {
    await chrome.tabs.sendMessage(tabIdentifier, message, { frameId: 0 });
    return true;
  } catch {
    return false;
  }
}

async function persistAndPublish(previousTabIdentifier) {
  // 計測状態をセッション内へ保存し、バッジと対象ページを更新する。
  await chrome.storage.session.set({ [snapshotKey]: { version: 1, state, exemptions } });
  const description = core.describeState(state, settings);
  const showTime = settings.enabled && state.connected && state.workKey && state.thresholdReached;
  // バッジは分単位へ切り上げ、長時間の値は表示幅に収める。
  const badge = !settings.enabled ? "" : !state.connected ? "!" : showTime
    ? `${Math.min(999, Math.ceil(state.balanceMilliseconds / 60000))}m` : "";
  const deliveries = [
    chrome.action.setBadgeText({ text: badge }),
    chrome.action.setBadgeBackgroundColor({ color: state.mode === "recovering" ? "#207967" : "#b54f36" }),
    chrome.action.setTitle({ title: `UniToDo Focus Monitor · ${description.label} · ${core.formatDuration(state.balanceMilliseconds)}` })
  ];
  if (previousTabIdentifier !== state.activeTabIdentifier) {
    deliveries.push(sendToTab(previousTabIdentifier, { type: "hide-overlay" }));
  }
  if (state.activeSite) {
    deliveries.push(sendToTab(state.activeTabIdentifier, { type: "snapshot", snapshot: getSnapshot(false) }));
  } else {
    deliveries.push(sendToTab(state.activeTabIdentifier, { type: "hide-overlay" }));
  }
  await Promise.all(deliveries);
}

async function refresh(force = false) {
  // 作業状態とブラウザ状態を同時に取得し、1回だけ計測を進める。
  const timestamp = Date.now();
  const previousTabIdentifier = state.activeTabIdentifier;
  const [work, browserContext] = await Promise.all([readWork(timestamp, force), readBrowserContext()]);
  for (const [tabIdentifier, deadline] of Object.entries(exemptions)) {
    if (!Number.isFinite(deadline) || deadline <= timestamp) delete exemptions[tabIdentifier];
  }
  state = core.reconcileState(state, {
    ...work, ...browserContext, timestamp,
    exemptUntil: exemptions[browserContext.tabIdentifier] ?? 0
  }, settings);
  await persistAndPublish(previousTabIdentifier);
  return getSnapshot();
}

function isExtensionPage(sender) {
  // 設定変更の要求元を、この拡張のポップアップだけに限定する。
  return sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html");
}

async function handleMessage(message, sender) {
  // ページからの状態確認と、ポップアップからの操作を処理する。
  if (!message || sender.id !== chrome.runtime.id) throw new Error("要求元を確認できません。");
  if (message.type === "heartbeat" && sender.tab && sender.frameId === 0) {
    const allowed = core.identifySite(sender.url, { ...getTrackingSettings(), monitorSocial: true, monitorVideo: true });
    if (!allowed) return { ok: true, deactivate: true };
    await refresh();
    return { ok: true, snapshot: getSnapshot(false) };
  }
  if (!isExtensionPage(sender)) throw new Error("この操作は拡張のポップアップから実行してください。");
  if (message.type === "get-snapshot") return { ok: true, snapshot: await refresh(message.force === true) };
  if (message.type === "save-settings") {
    // 設定変更までの時間は古い倍率で確定し、変更後から新設定を適用する。
    state = core.advanceState(state, Date.now(), settings);
    settings = core.normalizeSettings({ ...settings, ...message.settings, customSites: settings.customSites });
    await chrome.storage.local.set({ settings });
    return { ok: true, snapshot: await refresh() };
  }
  if (message.type === "add-site" || message.type === "remove-site") return changeCustomSite(message);
  if (message.type === "refresh-site-permissions") {
    await synchronizeCustomSites();
    for (const domain of permittedCustomSites) await injectOpenSiteTabs(domain);
    return { ok: true, snapshot: await refresh() };
  }
  if (message.type === "exclude-tab" || message.type === "include-tab") {
    await refresh();
    if (!state.activeSite || state.activeTabIdentifier === null) throw new Error("対象サイトのタブを開いてください。");
    if (message.type === "exclude-tab") exemptions[state.activeTabIdentifier] = Date.now() + 15 * 60 * 1000;
    else delete exemptions[state.activeTabIdentifier];
    return { ok: true, snapshot: await refresh() };
  }
  if (message.type === "preview") {
    await refresh();
    if (!state.activeSite || !(await sendToTab(state.activeTabIdentifier, { type: "preview", settings }))) {
      throw new Error("対象サイトのページを開き、再読み込みしてからお試しください。");
    }
    return { ok: true };
  }
  throw new Error("対応していない操作です。");
}

function requestRefresh() {
  // ブラウザイベントを受けて最新状態の確認を予約する。
  void enqueue(function refreshFromEvent() {
    // イベント直後の作業状態と前面タブを反映する。
    return refresh();
  });
}

// 休止したService Workerも復帰できるよう、イベントを最上位で登録する。
chrome.runtime.onConnect.addListener(function receivePopupConnection(port) {
  // 本物の拡張ポップアップからの接続だけを、前面判定の補助に使う。
  if (port.name !== "focus-monitor-popup" || !isExtensionPage(port.sender) || port.sender.tab) return;
  port.onMessage.addListener(function receivePopupFocus(message) {
    // フォーカス情報に短い期限を付け、閉じた画面を前面として扱わない。
    void enqueue(function updatePopupPresence() {
      // ブラウザウィンドウ単位で、現在のポップアップのフォーカスを記録する。
      if (!Number.isInteger(message.windowIdentifier) || typeof message.focused !== "boolean") return;
      popupPresence = { port, windowIdentifier: message.windowIdentifier, focused: message.focused, validUntil: Date.now() + 2500 };
      return refresh();
    });
  });
  port.onDisconnect.addListener(function handlePopupDisconnect() {
    // ポップアップを閉じたら、通常のChrome前面判定へ直ちに戻す。
    void enqueue(function clearPopupPresence() {
      // 他の新しいポップアップの状態は消さず、この接続だけを終了する。
      if (popupPresence?.port === port) popupPresence = null;
      return refresh();
    });
  });
});
chrome.runtime.onMessage.addListener(function receiveMessage(message, sender, sendResponse) {
  // 非同期応答が完了するまでメッセージ経路を保持する。
  enqueue(function dispatchMessage() {
    // 受信したメッセージを直列の処理へ渡す。
    return handleMessage(message, sender);
  }).then(function respond(result) {
    // 操作結果を要求元へ返す。
    sendResponse(result);
  }, function respondWithError(error) {
    // 表示可能なエラーだけを要求元へ返す。
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});
chrome.alarms.onAlarm.addListener(function handleAlarm(alarm) {
  // この拡張の定期アラームだけで再確認する。
  if (alarm.name === alarmName) requestRefresh();
});
chrome.tabs.onActivated.addListener(requestRefresh);
chrome.tabs.onUpdated.addListener(function handleTabUpdate(tabIdentifier, changes, tab) {
  // アクティブタブの移動・再読み込みを直ちに反映する。
  if (tab.active && (changes.url || changes.status === "complete")) requestRefresh();
});
chrome.tabs.onRemoved.addListener(function handleTabRemoval(tabIdentifier) {
  // 閉じたタブの除外情報を破棄し、計測対象を再確認する。
  void enqueue(async function removeTabExemption() {
    // 同じ番号が再利用される前に除外状態を削除する。
    delete exemptions[tabIdentifier];
    await refresh();
  });
});
chrome.windows.onFocusChanged.addListener(requestRefresh);
chrome.idle.onStateChanged.addListener(requestRefresh);
chrome.runtime.onStartup.addListener(requestRefresh);
chrome.runtime.onInstalled.addListener(requestRefresh);
chrome.permissions.onAdded.addListener(function handleGrantedPermissions() {
  // 権限を変更した直後に、利用可能な追加サイトを再確認する。
  void enqueue(async function refreshGrantedSites() {
    // 動的スクリプトと前面タブへ許可の変更を反映する。
    await synchronizeCustomSites();
    await refresh();
  });
});
chrome.permissions.onRemoved.addListener(function handleRevokedPermissions() {
  // Chrome側で権限が解除されたサイトの計測を止める。
  void enqueue(async function refreshRevokedSites() {
    // 失われた権限を、登録スクリプトと表示へ反映する。
    await synchronizeCustomSites();
    await refresh();
  });
});
requestRefresh();
