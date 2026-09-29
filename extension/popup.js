// ポップアップ内の設定入力と最新の計測状態を保持する。
const core = globalThis.FocusMonitorCore;
let snapshot = null;
let initialized = false;
let refreshPending = false;
// 元のChromeウィンドウとポップアップ接続、サイト一覧の描画済み内容を保持する。
let popupPort = null;
let popupWindowIdentifier = null;
let renderedSitesKey = "";
const elements = {};
for (const identifier of [
  "enabled", "timer-panel", "status-label", "timer-value", "progress-value", "threshold-note",
  "direction-note", "work-title", "bounce-enabled", "exclude-tab", "preview",
  "exclusion-note", "threshold-seconds", "recovery-rate", "monitor-social", "monitor-video", "feedback", "settings-form",
  "timer-size", "timer-size-value", "custom-sites", "site-form", "site-input", "add-site",
  "bounce-threshold-seconds", "bounce-note"
]) elements[identifier] = document.getElementById(identifier);

async function connectPopupFocus() {
  // ポップアップの親ウィンドウを特定して、前面状態を背景処理へ伝える。
  if (popupPort || !chrome.runtime?.id) return;
  try {
    const browserWindow = await chrome.windows.getCurrent();
    popupWindowIdentifier = browserWindow.id;
    popupPort = chrome.runtime.connect({ name: "focus-monitor-popup" });
    popupPort.onDisconnect.addListener(function handleFocusPortDisconnect() {
      // 背景処理の再起動時に、次の更新で接続し直せるようにする。
      popupPort = null;
    });
    reportPopupFocus();
  } catch { /* 一時的に接続できない場合は次の状態更新で再試行する。 */ }
}

function reportPopupFocus() {
  // ポップアップにフォーカスがある間も、元の対象タブの計測を継続させる。
  if (!popupPort) return;
  try {
    popupPort.postMessage({ windowIdentifier: popupWindowIdentifier, focused: document.hasFocus() && document.visibilityState === "visible" });
  } catch { popupPort = null; }
}

function showFeedback(message, isError = false) {
  // 保存完了や操作エラーを、読み上げ可能な短い文で表示する。
  elements.feedback.textContent = message;
  elements.feedback.dataset.error = String(isError);
}

async function request(message) {
  // 背景処理への操作を送信し、最新状態と操作結果を受け取る。
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "拡張を再読み込みしてください。");
  if (response.snapshot) snapshot = response.snapshot;
  render();
  return response;
}

function populateSettings() {
  // 初回だけ保存済みの設定をフォームへ反映し、編集中の値を守る。
  const settings = snapshot.settings;
  elements.enabled.checked = settings.enabled;
  elements["bounce-enabled"].checked = settings.bounceEnabled;
  elements["threshold-seconds"].value = settings.thresholdSeconds;
  elements["bounce-threshold-seconds"].value = settings.bounceThresholdSeconds;
  elements["recovery-rate"].value = settings.recoveryRate;
  elements["monitor-social"].checked = settings.monitorSocial;
  elements["monitor-video"].checked = settings.monitorVideo;
  elements["timer-size"].value = settings.timerSizePixels;
  elements["timer-size-value"].value = `${settings.timerSizePixels} px`;
  initialized = true;
}

function renderSites() {
  // サイト一覧が変わった場合だけ、削除と再許可の操作を描画する。
  const sites = snapshot.settings.customSites;
  const needsPermission = snapshot.sitesNeedingPermission ?? [];
  const nextKey = JSON.stringify([sites, needsPermission]);
  if (renderedSitesKey === nextKey) return;
  renderedSitesKey = nextKey;
  elements["custom-sites"].replaceChildren();
  for (const domain of sites) {
    const row = document.createElement("li");
    row.className = "custom-site";
    const label = document.createElement("span");
    label.textContent = domain;
    row.append(label);
    if (needsPermission.includes(domain)) {
      const grantButton = document.createElement("button");
      grantButton.type = "button";
      grantButton.textContent = "許可する";
      grantButton.addEventListener("click", async function restoreSitePermission() {
        // 権限が解除されたサイトを、ユーザーの操作で再び有効にする。
        try {
          const granted = await chrome.permissions.request({ origins: [core.getSitePattern(domain)] });
          if (!granted) return showFeedback("アクセスが許可されなかったため、このサイトは計測しません。", true);
          await request({ type: "refresh-site-permissions" });
          showFeedback(`${domain} の計測を再開しました。`);
        } catch (error) { showFeedback(error.message, true); }
      });
      row.append(grantButton);
    }
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "削除";
    removeButton.setAttribute("aria-label", `${domain} を削除`);
    removeButton.addEventListener("click", async function removeRegisteredSite() {
      // 選択したサイトを計測対象とアクセス権限から取り除く。
      removeButton.disabled = true;
      try {
        await request({ type: "remove-site", site: domain });
        showFeedback(`${domain} を削除しました。`);
      } catch (error) {
        removeButton.disabled = false;
        showFeedback(error.message, true);
      }
    });
    row.append(removeButton);
    elements["custom-sites"].append(row);
  }
}

function render() {
  // 計測値を補間し、接続・作業・除外の状態を表示する。
  if (!snapshot) return;
  if (!initialized) populateSettings();
  renderSites();
  const timestamp = Date.now();
  const settings = snapshot.settings;
  const state = core.advanceState(snapshot.state, timestamp, settings);
  const description = core.describeState(state, settings, timestamp);
  elements["timer-panel"].dataset.kind = description.kind;
  elements["status-label"].textContent = description.label;
  elements["timer-value"].textContent = core.formatDuration(state.balanceMilliseconds);
  // 閾値に対する残高の割合を、最大100%の進捗線へ変換する。
  elements["progress-value"].style.width = `${Math.min(100, state.balanceMilliseconds / (settings.thresholdSeconds * 10))}%`;
  elements["threshold-note"].textContent = settings.thresholdSeconds % 60 === 0
    ? `${settings.thresholdSeconds / 60}分で画面に表示` : `${settings.thresholdSeconds}秒で画面に表示`;
  // 保存済みの移動開始時間を、分または秒の短い案内へ変換する。
  const bounceStart = settings.bounceThresholdSeconds % 60 === 0
    ? `${settings.bounceThresholdSeconds / 60}分` : `${settings.bounceThresholdSeconds}秒`;
  elements["bounce-note"].textContent = settings.bounceEnabled
    ? `${bounceStart}から移動。反射するたびに色が変わります。` : "OFF：右下に赤で固定します。";
  elements["direction-note"].textContent = state.mode === "watching" ? "+1秒 / 秒" : state.mode === "recovering" ? `−${settings.recoveryRate}秒 / 秒` : "保留中";
  elements["work-title"].textContent = state.workTitle || (state.connected ? "作業タイマー停止中" : "接続を待っています");
  elements["work-title"].title = state.workTitle;
  const exempt = state.exemptUntil > timestamp;
  elements["exclude-tab"].disabled = !state.activeSite;
  elements.preview.disabled = !state.activeSite;
  elements["exclude-tab"].textContent = exempt ? "このタブの除外を解除" : "このタブを15分除外";
  elements["exclusion-note"].textContent = exempt
    ? `除外はあと${Math.ceil((state.exemptUntil - timestamp) / 60000)}分。同じタブ内の移動にも適用します。`
    : "";
}

async function refresh() {
  // 開いている間だけ状態を更新し、重複した問い合わせを避ける。
  if (refreshPending) return;
  refreshPending = true;
  try {
    if (!popupPort) await connectPopupFocus();
    reportPopupFocus();
    await request({ type: "get-snapshot" });
  }
  catch (error) { showFeedback(error.message, true); }
  finally { refreshPending = false; }
}

async function saveQuickSetting(property, element) {
  // ON/OFFの変更を即時保存し、失敗した場合は表示を戻す。
  element.disabled = true;
  try {
    await request({ type: "save-settings", settings: { [property]: element.checked } });
    showFeedback("設定を保存しました。");
  } catch (error) {
    element.checked = !element.checked;
    showFeedback(error.message, true);
  } finally { element.disabled = false; }
}

// よく使う操作は即時保存し、数値の設定はフォームからもまとめて保存する。
elements.enabled.addEventListener("change", function changeEnabled() {
  // モニター全体の一時停止を切り替える。
  void saveQuickSetting("enabled", elements.enabled);
});
elements["bounce-enabled"].addEventListener("change", function changeBounce() {
  // 移動表示と右下固定表示を切り替える。
  void saveQuickSetting("bounceEnabled", elements["bounce-enabled"]);
});
elements["timer-size"].addEventListener("input", function previewSizeValue() {
  // スライダーで選択中の文字サイズを表示する。
  elements["timer-size-value"].value = `${elements["timer-size"].value} px`;
});
elements["timer-size"].addEventListener("change", async function saveTimerSize() {
  // スライダーを確定した時点で、ページ上のタイマーへサイズを適用する。
  try {
    await request({ type: "save-settings", settings: { timerSizePixels: Number(elements["timer-size"].value) } });
    showFeedback("タイマーのサイズを保存しました。");
  } catch (error) { showFeedback(error.message, true); }
});
elements["monitor-social"].addEventListener("change", function changeSocialMonitoring() {
  // 標準のXとTwitterの計測を切り替える。
  void saveQuickSetting("monitorSocial", elements["monitor-social"]);
});
elements["monitor-video"].addEventListener("change", function changeVideoMonitoring() {
  // 標準のYouTubeの計測を切り替える。
  void saveQuickSetting("monitorVideo", elements["monitor-video"]);
});
elements["settings-form"].addEventListener("submit", async function saveSettings(event) {
  // 表示・移動の開始時間、サイズ、減少速度、対象サイトを保存する。
  event.preventDefault();
  if (!elements["settings-form"].reportValidity()) return;
  try {
    await request({ type: "save-settings", settings: {
      thresholdSeconds: Number(elements["threshold-seconds"].value),
      bounceThresholdSeconds: Number(elements["bounce-threshold-seconds"].value),
      timerSizePixels: Number(elements["timer-size"].value),
      recoveryRate: Number(elements["recovery-rate"].value),
      monitorSocial: elements["monitor-social"].checked,
      monitorVideo: elements["monitor-video"].checked
    } });
    showFeedback("計測の設定を保存しました。");
  } catch (error) { showFeedback(error.message, true); }
});
elements["site-form"].addEventListener("submit", async function addTargetSite(event) {
  // 登録ボタンの操作を起点に、そのドメインだけのアクセス許可を求める。
  event.preventDefault();
  if (!elements["site-form"].reportValidity() || !snapshot) return;
  try {
    const domain = core.normalizeSiteInput(elements["site-input"].value);
    core.validateNewSite(domain, snapshot.settings);
    elements["add-site"].disabled = true;
    elements["site-input"].disabled = true;
    const granted = await chrome.permissions.request({ origins: [core.getSitePattern(domain)] });
    if (!granted) return showFeedback("アクセスが許可されなかったため、登録しませんでした。", true);
    await request({ type: "add-site", site: domain });
    elements["site-input"].value = "";
    showFeedback(`${domain} を追加しました。`);
  } catch (error) { showFeedback(error.message, true); }
  finally {
    elements["add-site"].disabled = false;
    elements["site-input"].disabled = false;
  }
});
elements["exclude-tab"].addEventListener("click", async function toggleExclusion() {
  // 現在のタブの15分除外を開始または解除する。
  try {
    await request({ type: snapshot.state.exemptUntil > Date.now() ? "include-tab" : "exclude-tab" });
    showFeedback(snapshot.state.exemptUntil > Date.now() ? "このタブを15分間、計測対象から外しました。" : "除外を解除しました。");
  } catch (error) { showFeedback(error.message, true); }
});
elements.preview.addEventListener("click", async function previewOverlay() {
  // 現在の対象ページで表示だけを10秒間試す。
  try {
    await request({ type: "preview" });
    window.close();
  } catch (error) { showFeedback(error.message, true); }
});
setInterval(refresh, 1000);
setInterval(render, 250);
window.addEventListener("focus", reportPopupFocus);
window.addEventListener("blur", reportPopupFocus);
document.addEventListener("visibilitychange", reportPopupFocus);
window.addEventListener("pagehide", function disconnectPopupFocus() {
  // ポップアップを閉じるときに、前面状態の補助を直ちに終了する。
  popupPort?.disconnect();
  popupPort = null;
});
void refresh();
