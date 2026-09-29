import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

// テスト専用のChromeと成果物保存先を指定し、通常のユーザープロファイルから分離する。
const require = createRequire(import.meta.url);
const playwright = require(process.env.FOCUS_PLAYWRIGHT_PATH || "playwright");
const artifactDirectory = resolve(".test-artifacts");
await mkdir(artifactDirectory, { recursive: true });
const profileDirectory = await mkdtemp(resolve(artifactDirectory, "chrome-profile-"));
const context = await playwright.chromium.launchPersistentContext(profileDirectory, {
  executablePath: process.env.FOCUS_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  viewport: { width: 1280, height: 800 },
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging", "--disable-component-extensions-with-background-pages"]
});

async function attachPopup(browserSession, targetIdentifier) {
  // Playwrightが一覧へ出さないツールバーポップアップへ、公式CDPで接続する。
  const { sessionId: sessionIdentifier } = await browserSession.send("Target.attachToTarget", {
    targetId: targetIdentifier, flatten: false
  });
  let nextCommandIdentifier = 0;
  const pendingCommands = new Map();
  browserSession.on("Target.receivedMessageFromTarget", function receivePopupResult(event) {
    // このポップアップ宛ての応答を、待機している呼び出しへ戻す。
    if (event.sessionId !== sessionIdentifier) return;
    const response = JSON.parse(event.message);
    const pending = pendingCommands.get(response.id);
    if (!pending) return;
    pendingCommands.delete(response.id);
    if (response.error) pending.reject(new Error(response.error.message));
    else pending.resolve(response.result);
  });

  async function sendCommand(method, parameters = {}) {
    // ポップアップのDevToolsへ1件の要求を送る。
    nextCommandIdentifier += 1;
    const commandIdentifier = nextCommandIdentifier;
    const response = new Promise(function registerPendingResponse(resolve, reject) {
      // 要求番号に対応する応答処理を登録する。
      pendingCommands.set(commandIdentifier, { resolve, reject });
    });
    await browserSession.send("Target.sendMessageToTarget", {
      sessionId: sessionIdentifier, message: JSON.stringify({ id: commandIdentifier, method, params: parameters })
    });
    return response;
  }

  async function evaluate(operation) {
    // テスト対象のポップアップ内でDOMの操作や確認を行う。
    const response = await sendCommand("Runtime.evaluate", {
      expression: `(${operation.toString()})()`, awaitPromise: true, returnByValue: true, userGesture: true
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result?.value;
  }

  async function waitFor(predicate) {
    // ポップアップの非同期保存が反映されるまで、最大10秒待つ。
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await evaluate(predicate)) return;
      await new Promise(function waitForNextCheck(resolve) {
        // 連続問い合わせを避けて、画面更新に時間を渡す。
        setTimeout(resolve, 100);
      });
    }
    throw new Error("ポップアップの状態更新が時間内に完了しませんでした。");
  }

  async function screenshot(path) {
    // Chromeが描いた実際のポップアップをPNGへ保存する。
    const result = await sendCommand("Page.captureScreenshot", { format: "png" });
    await writeFile(path, Buffer.from(result.data, "base64"));
  }
  return { evaluate, waitFor, screenshot };
}

try {
  // Chrome公式の拡張デバッグAPIで、このテスト用プロファイルへだけ読み込む。
  const browserSession = await context.browser().newBrowserCDPSession();
  const extension = await browserSession.send("Extensions.loadUnpacked", { path: resolve("extension") });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  console.log(`Loaded extension ${extension.id}`);
  const [page] = context.pages();
  page.on("pageerror", function reportPageError(error) {
    // ポップアップのJavaScriptエラーを検出する。
    console.log("Page error:", error.message);
  });
  await page.goto(`chrome-extension://${extension.id}/popup.html`);
  await page.waitForFunction(function waitForConnectionState() {
    // 初回のAPI確認結果が画面へ反映されるまで待つ。
    return document.getElementById("status-label").textContent !== "接続を確認しています" ||
      Boolean(document.getElementById("feedback").textContent);
  });
  const status = await page.locator("#status-label").textContent();
  const feedback = await page.locator("#feedback").textContent();
  console.log(JSON.stringify({ status, feedback }));
  await page.screenshot({ path: resolve(artifactDirectory, "popup-initial.png"), mask: [page.locator("#work-title")] });
  assert.equal(feedback, "");
  const diagnostic = await worker.evaluate(function readWorkerDiagnostics() {
    // タスクの具体名を出力せず、接続できたことだけを確認する。
    return { connected: state.connected, working: Boolean(state.workKey), mode: state.mode };
  });
  console.log(JSON.stringify(diagnostic));
  assert.equal(diagnostic.connected, true, "実際のUniToDo APIに接続できていません。");

  // 以降は作業状態だけをテスト用へ差し替え、UniToDo本体には書き込まない。
  await worker.evaluate(async function useTestWorkEntry() {
    // テスト用の作業ログをGETの戻り値として返す。
    globalThis.fetch = async function readTestWorkEntry() {
      // 作業中・停止・通信切断をテスト側から切り替えられるようにする。
      if (globalThis.focusTestOffline) throw new TypeError("Test offline");
      return new Response(globalThis.focusTestStopped ? "" : JSON.stringify({
        identifier: "browser-test-entry", taskIdentifier: "browser-test-task", title: "資料をまとめる（テスト）",
        startAt: "2026-09-05T00:00:00Z", endAt: null
      }), { status: 200 });
    };
    await enqueue(async function resetTestState() {
      // 実際の状態をテストへ持ち越さず、テスト専用の計測を開始する。
      state = core.createState();
      await refresh(true);
    });
  });

  const targetPage = await context.newPage();
  targetPage.on("pageerror", function reportTargetError(error) {
    // コンテンツスクリプトとテストページの描画エラーを検出する。
    throw error;
  });
  await targetPage.route("https://www.youtube.com/**", async function provideTestPage(route) {
    // 外部サイトへ通信せず、YouTubeオリジン上に検証用ページを表示する。
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Focus Monitor · 表示テスト</title><style>
      *{box-sizing:border-box}body{margin:0;background:#f7f7f5;color:#252923;font:16px 'Segoe UI','Yu Gothic UI',sans-serif}
      header{padding:24px 40px;border-bottom:1px solid #ddd;display:flex;justify-content:space-between;background:white}
      main{padding:42px;max-width:1040px;margin:auto}.video{height:410px;border-radius:18px;background:#29352e;color:#dbe5d1;display:grid;place-items:center}
      .video span{text-align:center;font-size:18px;letter-spacing:2px}.video small{display:block;font-size:12px;margin-top:12px;opacity:.6}
      h1{font-size:22px;margin-top:25px}p{font-size:14px;color:#899082}button{border:1px solid #c6cebe;background:white;padding:10px 16px;border-radius:7px}
      </style></head><body><header><strong>VIDEO / TEST PAGE</strong><span>UniToDo Focus Monitor</span></header><main>
      <div class="video" id="video"><span>表示テスト用のページ<small>実際の動画は再生していません</small><button id="fullscreen">全画面で確認</button></span></div>
      <h1>対象サイトでのタイマー表示</h1><p>タイマーはクリックを遮らず、画面の端で反射します。</p><button id="underlay">ページの操作</button></main>
      <script>document.getElementById('fullscreen').addEventListener('click', function enterFullscreen() {
      // 検証用の動画領域を全画面へ切り替える。
      document.getElementById('video').requestFullscreen(); });</script></body></html>` });
  });
  await targetPage.goto("https://www.youtube.com/watch?v=focus-monitor-test");
  await targetPage.bringToFront();
  const watching = await worker.evaluate(async function verifyWatching() {
    // 実際のChromeタブ情報から閲覧判定できることを確認する。
    await enqueue(function refreshTestBrowser() {
      // 前面タブの変化を確定する。
      return refresh(true);
    });
    return { mode: state.mode, site: state.activeSite, tabIdentifier: state.activeTabIdentifier };
  });
  console.log(JSON.stringify({ watching }));
  assert.equal(watching.mode, "watching");

  await worker.evaluate(async function seedThresholdBoundary() {
    // 最初の59秒だけを準備し、残り1秒は本物の表示更新で閾値を跨ぐ。
    await enqueue(async function publishBoundary() {
      // 同時実行の更新と競合しないように、境界値を直列保存する。
      state.balanceMilliseconds = 59000;
      state.thresholdReached = false;
      state.updatedAt = Date.now();
      state.validUntil = Date.now() + 12000;
      await persistAndPublish(state.activeTabIdentifier);
    });
  });
  await targetPage.waitForFunction(function waitForVisibleTimer() {
    // 60秒へ達したタイマーがトップレイヤーに表示されるまで待つ。
    return document.querySelector("unitodo-focus-timer")?.matches(":popover-open");
  }, null, { timeout: 10000 });
  const overlay = targetPage.locator("unitodo-focus-timer");
  await targetPage.waitForFunction(function waitForNotoSerif() {
    // 同梱フォントがフォールバックではなく読み込まれたことを確認する。
    return Array.from(document.fonts).some(function isTimerFontReady(font) {
      // タイマー専用のNoto Serifが読み込み済みかを確認する。
      return font.family === "UniToDo Noto Serif" && font.status === "loaded";
    });
  });
  const firstBounds = await overlay.boundingBox();
  await targetPage.waitForTimeout(1000);
  const fixedBeforeFiveMinutes = await overlay.boundingBox();
  assert.ok(Math.abs(fixedBeforeFiveMinutes.x - firstBounds.x) < 1);
  assert.ok(Math.abs(fixedBeforeFiveMinutes.y - firstBounds.y) < 1);
  assert.equal(await targetPage.locator("unitodo-focus-timer .value").evaluate(function readFixedTimerColor(element) {
    // 5分未満の固定表示でも、赤が適用されていることを確認する。
    return getComputedStyle(element).color;
  }), "rgb(178, 60, 50)");
  await targetPage.screenshot({ path: resolve(artifactDirectory, "overlay-one-minute.png") });
  await worker.evaluate(async function seedBounceBoundary() {
    // 4分59秒から、実際の時間経過で5分の移動開始を確認する。
    await enqueue(async function publishBounceBoundary() {
      // 移動開始直前の残高を、表示へ同期する。
      state.balanceMilliseconds = 299000;
      state.updatedAt = Date.now();
      state.validUntil = Date.now() + 12000;
      await persistAndPublish(state.activeTabIdentifier);
    });
  });
  await targetPage.waitForFunction(function waitForMovement(previousHorizontal) {
    // 少なくとも20ピクセル移動し、DVD表示が実際に動くことを確認する。
    return Math.abs(document.querySelector("unitodo-focus-timer").getBoundingClientRect().left - previousHorizontal) > 20;
  }, firstBounds.x);
  const movingBounds = await overlay.boundingBox();
  assert.ok(movingBounds.x >= 0 && movingBounds.y >= 0);
  assert.ok(movingBounds.x + movingBounds.width <= 1280);
  assert.ok(movingBounds.y + movingBounds.height <= 800);
  assert.equal(await overlay.evaluate(function readPointerBehavior(element) {
    // ページ操作を遮断しないCSSになっていることを確認する。
    return getComputedStyle(element).pointerEvents;
  }), "none");
  await targetPage.screenshot({ path: resolve(artifactDirectory, "overlay-bounce.png") });

  // 小さい検証用画面で反射を待ち、移動中の色変更を実際の描画から確認する。
  await targetPage.setViewportSize({ width: 480, height: 280 });
  await targetPage.waitForTimeout(300);
  const reflectionColors = await targetPage.evaluate(function observeReflectionColors() {
    // 異なる色への切り替えが、画面端で2回起きるまで観測する。
    const host = document.querySelector("unitodo-focus-timer");
    const timer = host.shadowRoot.querySelector(".value");
    let previousColor = getComputedStyle(timer).color;
    const observedColors = [previousColor];
    const deadline = Date.now() + 15000;
    return new Promise(function waitForReflections(resolve, reject) {
      // ページの描画に合わせて、文字色と端への到達を調べる。
      function sampleFrame() {
        // 色が変わったフレームの位置を確認し、通常の移動中の色変更を検出する。
        const color = getComputedStyle(timer).color;
        if (color !== previousColor) {
          const bounds = host.getBoundingClientRect();
          const atEdge = bounds.left <= 20 || bounds.top <= 20 || bounds.right >= innerWidth - 20 || bounds.bottom >= innerHeight - 20;
          if (!atEdge) return reject(new Error("画面端以外で色が変わりました。"));
          observedColors.push(color);
          previousColor = color;
        }
        if (observedColors.length === 3) return resolve(observedColors);
        if (Date.now() >= deadline) return reject(new Error("反射時の色変更を確認できませんでした。"));
        requestAnimationFrame(sampleFrame);
      }
      requestAnimationFrame(sampleFrame);
    });
  });
  assert.notEqual(reflectionColors[0], reflectionColors[1]);
  assert.notEqual(reflectionColors[1], reflectionColors[2]);
  await targetPage.screenshot({ path: resolve(artifactDirectory, "overlay-reflection.png") });
  await targetPage.setViewportSize({ width: 1280, height: 800 });

  // 本物のツールバーポップアップを開いて、表示切替とタブ除外を操作する。
  const targetSession = await context.newCDPSession(targetPage);
  await worker.evaluate(async function openToolbarPopup() {
    // Chrome自身のアクションAPIで本物のポップアップを開く。
    await chrome.action.openPopup();
  });
  const targets = await browserSession.send("Target.getTargets");
  const popupTarget = targets.targetInfos.find(function findToolbarPopup(target) {
    // 別タブの設定画面ではなく、新しく開いたツールバーのポップアップを選ぶ。
    return target.url === `chrome-extension://${extension.id}/popup.html` && !target.attached;
  });
  assert.ok(popupTarget, "Chromeのポップアップページを取得できませんでした。");
  const popupPage = await attachPopup(browserSession, popupTarget.targetId);
  await popupPage.waitFor(function waitForWatchingPopup() {
    // 対象タブの状態がポップアップに反映されるまで待つ。
    return document.getElementById("status-label")?.textContent.includes("YouTube");
  });
  console.log("Popup focus:", await popupPage.evaluate(function readActualPopupFocus() {
    // Chrome本体とは独立したポップアップのフォーカスを確認する。
    return { focused: document.hasFocus(), windowIdentifier: popupWindowIdentifier };
  }));
  await worker.evaluate(async function simulateBrowserFocusMovingToPopup() {
    // Windowsでポップアップに移った際の、本体focused=falseを再現する。
    globalThis.focusTestNativeGetWindow = chrome.windows.getLastFocused.bind(chrome.windows);
    chrome.windows.getLastFocused = async function readUnfocusedBrowserWindow(options) {
      // 元のウィンドウ情報を保ちながら、本体のフォーカスだけを外す。
      return { ...await globalThis.focusTestNativeGetWindow(options), focused: false };
    };
    await enqueue(function refreshPopupFocusState() {
      // 本体のフォーカスがなくても、ポップアップ操作中の計測を確認する。
      return refresh();
    });
  });
  await popupPage.evaluate(function rememberPopupBalance() {
    // ポップアップ操作中の加算を確認するため、開始時の残高を控える。
    globalThis.focusTestOpeningBalance = snapshot.state.balanceMilliseconds;
  });
  await popupPage.waitFor(function verifyPopupKeepsCounting() {
    // ポップアップ上で1.5秒以上加算が進み、減算に変わらないことを確認する。
    return snapshot.state.mode === "watching" && snapshot.state.balanceMilliseconds > globalThis.focusTestOpeningBalance + 1500;
  });
  await worker.evaluate(function restoreBrowserFocusReader() {
    // 回帰確認を終えたので、本物のChrome前面判定へ戻す。
    chrome.windows.getLastFocused = globalThis.focusTestNativeGetWindow;
  });
  await popupPage.screenshot(resolve(artifactDirectory, "popup-watching.png"));
  await popupPage.evaluate(function changeTimerSize() {
    // 実際のサイズ入力の変更イベントから、96pxを保存する。
    document.getElementById("settings-details").open = true;
    const slider = document.getElementById("timer-size");
    slider.value = "96";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await popupPage.waitFor(function waitForSizeSaved() {
    // サイズ変更が保存されるまで待つ。
    return document.getElementById("feedback").textContent.includes("サイズを保存");
  });
  await popupPage.evaluate(function postponeBounceStart() {
    // 保存フォームから移動開始を10分に延ばし、現在の移動を止める。
    document.getElementById("bounce-threshold-seconds").value = "600";
    document.getElementById("settings-form").requestSubmit();
  });
  await popupPage.waitFor(function waitForLaterBounceStart() {
    // 背景処理の設定と案内文が、新しい開始時間を示すまで待つ。
    return snapshot.settings.bounceThresholdSeconds === 600 && document.getElementById("bounce-note").textContent.includes("10分");
  });
  await targetPage.waitForFunction(function waitForRedFixedTimerAfterPostponement() {
    // 移動開始を先へ延ばすと、色付きの移動表示が赤の右下固定に戻る。
    const host = document.querySelector("unitodo-focus-timer");
    return host?.matches(":popover-open") && Math.abs(host.getBoundingClientRect().bottom - (innerHeight - 18)) < 2 &&
      getComputedStyle(host.shadowRoot.querySelector(".value")).color === "rgb(178, 60, 50)";
  });
  await popupPage.evaluate(function chooseIndependentStartTimes() {
    // 表示開始30秒と移動開始120秒を、同じ保存操作で別々に指定する。
    document.getElementById("threshold-seconds").value = "30";
    document.getElementById("bounce-threshold-seconds").value = "120";
    document.getElementById("settings-form").requestSubmit();
  });
  await popupPage.waitFor(function waitForCustomStartTimes() {
    // 両方の設定が保存され、移動の案内が2分へ変わることを確認する。
    return snapshot.settings.thresholdSeconds === 30 && snapshot.settings.bounceThresholdSeconds === 120 &&
      document.getElementById("bounce-note").textContent.includes("2分");
  });
  await popupPage.evaluate(function showTimingControls() {
    // 新しい移動開始入力と保存ボタンを、設定画面の画像へ収める。
    document.getElementById("settings-details").scrollIntoView({ block: "end" });
  });
  await popupPage.screenshot(resolve(artifactDirectory, "popup-timing-settings.png"));
  await worker.evaluate(async function seedCustomBounceBoundary() {
    // 保存した2分の境界直前を準備し、残り1秒は実際に計測する。
    await enqueue(async function publishCustomBounceBoundary() {
      // 現在の対象タブへ1分59秒の表示を同期する。
      state.balanceMilliseconds = 119000;
      state.updatedAt = Date.now();
      state.validUntil = Date.now() + 12000;
      await persistAndPublish(state.activeTabIdentifier);
    });
  });
  await targetPage.waitForFunction(function waitForCustomBoundaryFixedTimer() {
    // 2分未満では移動せず、右下で赤く表示されることを確認する。
    const host = document.querySelector("unitodo-focus-timer");
    return host?.matches(":popover-open") && Math.abs(host.getBoundingClientRect().bottom - (innerHeight - 18)) < 2 &&
      host.shadowRoot.querySelector(".value").textContent === "01:59";
  });
  const customBoundaryBounds = await overlay.boundingBox();
  await targetPage.waitForFunction(function waitForConfiguredMovement(previousVertical) {
    // 5分を待たずに、指定した2分で移動し始めることを確認する。
    return Math.abs(document.querySelector("unitodo-focus-timer").getBoundingClientRect().top - previousVertical) > 20;
  }, customBoundaryBounds.y, { timeout: 10000 });
  await popupPage.evaluate(function disableBouncing() {
    // 実際のチェックボックス操作から移動表示を無効にする。
    document.getElementById("bounce-enabled").click();
  });
  await popupPage.waitFor(function waitForSavedSetting() {
    // 背景処理への保存成功を確認する。
    return document.getElementById("feedback").textContent.includes("設定を保存しました。");
  });
  await popupPage.evaluate(function excludeCurrentTab() {
    // 除外ボタンを押し、現在のYouTubeタブを除外する。
    document.getElementById("exclude-tab").click();
  });
  await popupPage.waitFor(function waitForExcludedStatus() {
    // 除外状態の表示へ切り替わるまで待つ。
    return document.getElementById("status-label").textContent.includes("除外中");
  });
  const excluded = await worker.evaluate(function readExcludedState() {
    // 画面操作から除外が背景処理へ届いたことを確認する。
    return { mode: state.mode, balance: state.balanceMilliseconds };
  });
  assert.equal(excluded.mode, "recovering");
  await popupPage.evaluate(function includeCurrentTab() {
    // 除外ボタンを再度押して閲覧計測へ戻す。
    document.getElementById("exclude-tab").click();
  });
  await popupPage.waitFor(function waitForIncludedStatus() {
    // 通常の閲覧状態へ戻るまで待つ。
    return document.getElementById("status-label").textContent.includes("YouTube");
  });
  await browserSession.send("Target.closeTarget", { targetId: popupTarget.targetId });
  await targetPage.bringToFront();
  await targetPage.waitForFunction(function waitForFixedTimer() {
    // 設定の変更後に、右下固定のタイマーへ戻るまで待つ。
    const element = document.querySelector("unitodo-focus-timer");
    if (!element?.matches(":popover-open")) return false;
    const bounds = element.getBoundingClientRect();
    return Math.abs(bounds.bottom - (innerHeight - 18)) < 2 && innerWidth - bounds.right > 18;
  });
  await targetPage.screenshot({ path: resolve(artifactDirectory, "overlay-fixed.png") });
  const timerStyle = await targetPage.locator("unitodo-focus-timer .value").evaluate(function readTimerTypography(element) {
    // 時間だけの表示と、Noto Serif・指定したサイズの適用を確認する。
    const style = getComputedStyle(element);
    return { family: style.fontFamily, size: style.fontSize, color: style.color, text: element.textContent };
  });
  assert.equal(timerStyle.size, "96px");
  assert.equal(timerStyle.color, "rgb(178, 60, 50)");
  assert.ok(timerStyle.family.includes("Noto Serif"));
  assert.match(timerStyle.text, /^\d+:\d{2}(?::\d{2})?$/u);

  await targetPage.locator("#fullscreen").click();
  await targetPage.waitForFunction(function waitForFullscreenTimer() {
    // 全画面の動画領域にもタイマーが表示されることを確認する。
    return document.fullscreenElement && document.querySelector("unitodo-focus-timer")?.matches(":popover-open");
  });
  await targetPage.screenshot({ path: resolve(artifactDirectory, "overlay-fullscreen.png") });
  await targetPage.evaluate(async function leaveFullscreen() {
    // 後続のタブ切り替えテストのために全画面を終了する。
    await document.exitFullscreen();
  });

  // 追加サイトを、標準サイトとは別の実オリジンと動的スクリプトで確認する。
  const customPage = await context.newPage();
  await customPage.route(/^https?:\/\/(?:[a-z]+\.)?example\.com\//u, async function provideCustomSite(route) {
    // 通信を外へ出さず、追加サイトの既存ページと次回読み込みを検証する。
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><html lang='ja'><meta charset='utf-8'><title>追加サイトのテスト</title><body style='background:#f5f4ef;font-family:serif;padding:60px'><h1>追加したサイト</h1><p>ドメイン登録と時間だけの表示を確認しています。</p></body></html>" });
  });
  await customPage.goto("https://www.example.com/feed");
  assert.equal(await customPage.locator("unitodo-focus-timer").count(), 0);

  // 許可ダイアログの代わりに、テスト用Chromeの管理画面からexample.comだけを事前許可する。
  const permissionsPage = await context.newPage();
  await permissionsPage.goto("chrome://extensions");
  await permissionsPage.evaluate(async function grantOnlyTestDomain(extensionIdentifier) {
    // Chromeの管理画面と同じAPIで、隔離プロファイル内の検証用ドメインだけを許可する。
    await chrome.developerPrivate.addHostPermission(extensionIdentifier, "*://*.example.com/*");
  }, extension.id);
  await permissionsPage.close();
  await customPage.bringToFront();
  await worker.evaluate(async function openCustomSitePopup() {
    // 追加したいページ上で本物の拡張ポップアップを開く。
    await chrome.action.openPopup();
  });
  const customTargets = await browserSession.send("Target.getTargets");
  const customPopupTarget = customTargets.targetInfos.find(function findCustomSitePopup(target) {
    // 新しく開いたポップアップを特定する。
    return target.url === `chrome-extension://${extension.id}/popup.html` && !target.attached;
  });
  assert.ok(customPopupTarget);
  const customPopup = await attachPopup(browserSession, customPopupTarget.targetId);
  await customPopup.waitFor(function waitForSiteForm() {
    // 初期状態が読み込まれるまで待つ。
    return typeof initialized !== "undefined" && initialized;
  });
  await customPopup.evaluate(function submitCustomSite() {
    // 実際のフォームから、URLでサイトを登録する。
    document.getElementById("sites-details").open = true;
    document.getElementById("site-input").value = "https://www.example.com/feed";
    document.getElementById("site-form").requestSubmit();
  });
  await customPopup.waitFor(function waitForCustomSiteAdded() {
    // 正規化されたドメインが一覧に登録されるまで待つ。
    return (document.getElementById("custom-sites").textContent.includes("example.com") &&
      document.getElementById("feedback").textContent.includes("追加しました")) ||
      document.getElementById("feedback").dataset.error === "true";
  });
  const addedSiteFeedback = await customPopup.evaluate(function readSiteRegistrationFeedback() {
    // サイト登録の成否を具体的に確認する。
    return document.getElementById("feedback").textContent;
  });
  assert.ok(addedSiteFeedback.includes("追加しました"), addedSiteFeedback);
  await worker.evaluate(async function publishCustomSiteTimer() {
    // 追加直後の既存タブへ、表示できる残高を同期する。
    await enqueue(async function seedCustomSiteBalance() {
      // 新規登録サイトでも同じ計測状態を表示する。
      state.balanceMilliseconds = 90000;
      state.thresholdReached = true;
      state.updatedAt = Date.now();
      state.validUntil = Date.now() + 12000;
      await persistAndPublish(state.activeTabIdentifier);
    });
  });
  await customPage.waitForFunction(function waitForInjectedCustomTimer() {
    // ページ再読み込みなしでスクリプトが適用されたことを確認する。
    return document.querySelector("unitodo-focus-timer")?.matches(":popover-open");
  });
  await customPopup.evaluate(function showRegisteredSiteControls() {
    // 登録結果と入力欄が画像内に収まる位置までスクロールする。
    document.getElementById("sites-details").scrollIntoView({ block: "end" });
  });
  await customPopup.screenshot(resolve(artifactDirectory, "popup-sites.png"));
  await browserSession.send("Target.closeTarget", { targetId: customPopupTarget.targetId });
  await customPage.bringToFront();
  await customPage.goto("https://news.example.com/next");
  await customPage.waitForFunction(function waitForAutomaticCustomTimer() {
    // 同じドメインの次のページにも、自動登録のスクリプトが動くことを確認する。
    return document.querySelector("unitodo-focus-timer")?.matches(":popover-open");
  });
  await customPage.screenshot({ path: resolve(artifactDirectory, "custom-site-timer.png") });

  await page.bringToFront();
  await page.reload();
  await page.waitForFunction(function waitForRestoredTimingInputs() {
    // 拡張画面を開き直しても、保存した開始時間が入力欄へ戻ることを確認する。
    return document.getElementById("threshold-seconds").value === "30" &&
      document.getElementById("bounce-threshold-seconds").value === "120";
  });
  await page.locator("#sites-details").evaluate(function openSiteList(element) {
    // 通常の拡張画面からも、登録サイトを削除できるようにする。
    element.open = true;
  });
  await page.getByRole("button", { name: "example.com を削除", exact: true }).click();
  await page.locator("#feedback").filter({ hasText: "example.com を削除しました。" }).waitFor();
  await customPage.waitForFunction(function waitForCustomTimerRemoval() {
    // 削除したページの表示が、再読み込み前に取り除かれることを確認する。
    return !document.querySelector("unitodo-focus-timer");
  });
  const removedSite = await worker.evaluate(async function inspectRemovedSite() {
    // スクリプト登録とアクセス権限も解除されたことを確認する。
    return {
      granted: await chrome.permissions.contains({ origins: ["*://*.example.com/*"] }),
      scripts: await chrome.scripting.getRegisteredContentScripts()
    };
  });
  assert.equal(removedSite.granted, false);
  assert.equal(removedSite.scripts.length, 0);

  const otherPage = await context.newPage();
  await otherPage.goto("about:blank");
  await otherPage.bringToFront();
  const recovering = await worker.evaluate(async function verifyRecoveryOnOtherTab() {
    // 対象外タブへ切り替えた時点で、Chromeイベントから減算へ変わることを確認する。
    await enqueue(function refreshAfterTabChange() {
      // 対象外タブを確定する。
      return refresh();
    });
    return state.mode;
  });
  assert.equal(recovering, "recovering");
  await worker.evaluate(async function simulateOffline() {
    // テスト用の通信を失敗させ、未接続へ移ることを確認する。
    globalThis.focusTestOffline = true;
    await enqueue(function refreshOfflineState() {
      // 通信失敗をすぐに取得する。
      return refresh(true);
    });
  });
  await page.bringToFront();
  await page.locator("#status-label").filter({ hasText: "未接続" }).waitFor();
  await page.screenshot({ path: resolve(artifactDirectory, "popup-offline.png") });
  await writeFile(resolve(artifactDirectory, "browser-result.json"), JSON.stringify({
    status, diagnostic, extensionLoaded: true, threshold: true, bouncing: true, clickThrough: true,
    popupControls: true, popupFocusRegression: true, timerSize: true, notoSerif: true,
    bounceStartsAtFiveMinutes: true, configurableBounceTime: true, reflectionColors: true, fixedTimerReturnsRed: true,
    customSiteRegistration: true, customSiteRemoval: true,
    exclusion: true, fullscreen: true, recovery: true, offline: true
  }, null, 2));
  console.log("Chrome実機確認: 反射時の色変更・固定時の赤・移動開始時間の保存と反映・ポップアップの加算継続・サイト登録と削除・全画面表示が成功しました。");
} catch (error) {
  // テストが失敗した地点を、ブラウザ終了前に記録する。
  console.error("Browser verification failed:", error.message);
  throw error;
} finally {
  // テスト用のChromeだけを終了する。
  await context.close();
}
