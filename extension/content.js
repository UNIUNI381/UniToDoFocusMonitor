(function initializePageMonitor() {
  // 対象サイトへ、操作を遮らないタイマー表示を追加する。
  "use strict";
  if (globalThis.unitodoFocusMonitorLoaded) return;
  globalThis.unitodoFocusMonitorLoaded = true;

  // 表示内容、プレビュー期限、拡張接続状態を保持する。
  const core = globalThis.FocusMonitorCore;
  let snapshot = null;
  let previewUntil = 0;
  let previewStartedAt = 0;
  let previewSettings = core.defaultSettings;
  let disconnected = false;
  let heartbeatPending = false;
  // 同梱したNoto Serifの読み込み状態を保持する。
  let fontLoading = null;
  // 表示要素、移動位置、反射方向、描画予約を保持する。
  let overlayHost = null;
  let timerValue = null;
  let horizontalPosition = 0;
  let verticalPosition = 0;
  let horizontalDirection = -1;
  let verticalDirection = -1;
  let previousFrameAt = 0;
  let animationIdentifier = 0;
  let heartbeatIdentifier = 0;
  let renderIdentifier = 0;
  // 固定表示の余白を合わせるための、フォント寸法の測定先を保持する。
  let measurementContext = null;
  // 固定時の赤、反射時に選ぶ色、現在の文字色を保持する。
  const fixedTimerColor = "#b23c32";
  const bounceColors = [fixedTimerColor, "#24724f", "#167c80", "#285db3", "#7540a6", "#b32f72", "#b35e16", "#8c741c"];
  let timerColor = fixedTimerColor;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  function loadTimerFont() {
    // ローカルのフォントをバイナリとして読み込み、ページの外部フォント設定から独立させる。
    if (fontLoading) return;
    fontLoading = (async function loadBundledFont() {
      // Noto Serifをページのフォント一覧へ登録する。
      const response = await fetch(chrome.runtime.getURL("fonts/NotoSerif.ttf"));
      if (!response.ok) throw new Error("同梱フォントを読み込めませんでした。");
      const font = new FontFace("UniToDo Noto Serif", await response.arrayBuffer(), { weight: "700" });
      await font.load();
      document.fonts.add(font);
      render();
    })().catch(function reportFontFailure(error) {
      // 読み込みに失敗した場合は、表示を維持しながら診断情報を残す。
      console.warn("Focus Monitor font:", error.message);
    });
  }

  function createOverlay() {
    // ページのCSSから独立した表示と、クリックを通す外枠を作る。
    if (overlayHost?.isConnected) return;
    loadTimerFont();
    overlayHost = document.createElement("unitodo-focus-timer");
    overlayHost.setAttribute("popover", "manual");
    overlayHost.setAttribute("aria-label", "UniToDo サボり継続時間");
    const hostStyles = {
      all: "initial", position: "fixed", inset: "auto", left: "0", top: "0", margin: "0",
      padding: "0", border: "0", width: "max-content", "max-width": "calc(100vw - 24px)", height: "auto",
      background: "transparent", overflow: "visible", "pointer-events": "none", "z-index": "2147483647",
      "color-scheme": "light", "box-sizing": "border-box"
    };
    for (const [property, value] of Object.entries(hostStyles)) overlayHost.style.setProperty(property, value, "important");
    const shadow = overlayHost.attachShadow({ mode: "open" });
    const styles = document.createElement("style");
    styles.textContent = `
      :host { pointer-events: none !important; }
      * { box-sizing: border-box; }
      .value { display: block; padding: 2px;
        color: ${fixedTimerColor}; font: 700 48px/1.2 "UniToDo Noto Serif", "Noto Serif", Georgia, serif;
        font-variant-numeric: lining-nums tabular-nums; letter-spacing: 0; white-space: nowrap;
        -webkit-text-stroke: 1.5px rgba(255, 255, 255, .95); paint-order: stroke fill;
        text-shadow: 0 1px 3px #0004; pointer-events: none; }
    `;
    timerValue = document.createElement("span");
    timerColor = fixedTimerColor;
    timerValue.className = "value";
    timerValue.setAttribute("role", "timer");
    timerValue.setAttribute("aria-live", "off");
    shadow.append(styles, timerValue);
    (document.fullscreenElement ?? document.documentElement).append(overlayHost);
    const bounds = getMovementBounds();
    horizontalPosition = bounds.maximumHorizontal;
    verticalPosition = bounds.maximumVertical;
  }

  function getMovementBounds() {
    // ウィンドウと数字の寸法から、画面内の移動範囲を求める。
    const width = overlayHost?.getBoundingClientRect().width || 145;
    const height = overlayHost?.getBoundingClientRect().height || 60;
    return {
      maximumHorizontal: Math.max(12, innerWidth - width - 18),
      maximumVertical: Math.max(12, innerHeight - height - 18)
    };
  }

  function getFixedHorizontalOffset() {
    // フォントの下側と右側の空白の差から、固定位置の補正量を求める。
    measurementContext ??= document.createElement("canvas").getContext("2d");
    if (!measurementContext) return 0;
    const typography = getComputedStyle(timerValue);
    measurementContext.font = `${typography.fontWeight} ${typography.fontSize} ${typography.fontFamily}`;
    measurementContext.textAlign = "left";
    // 同じ数字を基準にして、秒の更新で固定位置が左右へ揺れるのを防ぐ。
    const metrics = measurementContext.measureText("0");
    const bottomWhitespace = (Number.parseFloat(typography.lineHeight) - metrics.fontBoundingBoxAscent +
      metrics.fontBoundingBoxDescent) / 2 - metrics.actualBoundingBoxDescent;
    const rightWhitespace = metrics.width - metrics.actualBoundingBoxRight;
    return bottomWhitespace - rightWhitespace;
  }

  function hideOverlay() {
    // 非表示にして、不要なアニメーションを停止する。
    if (animationIdentifier) cancelAnimationFrame(animationIdentifier);
    animationIdentifier = 0;
    previousFrameAt = 0;
    if (overlayHost) {
      if (overlayHost.matches(":popover-open")) overlayHost.hidePopover();
      overlayHost.style.setProperty("display", "none", "important");
    }
  }

  function changeBounceColor() {
    // 直前の色を除いた候補から、反射後の文字色をランダムに選ぶ。
    const candidates = bounceColors.filter(function excludeCurrentColor(color) {
      // 毎回必ず色が変わるように、現在の色を候補から外す。
      return color !== timerColor;
    });
    // 0以上1未満の乱数を候補数で拡大し、選択する位置へ変換する。
    timerColor = candidates[Math.floor(Math.random() * candidates.length)];
    timerValue.style.color = timerColor;
  }

  function getDisplayState() {
    // 最新の計測値を補間し、表示テストを通常計測から独立させる。
    const timestamp = Date.now();
    if (disconnected || document.visibilityState !== "visible" || (!document.hasFocus() && !snapshot?.state.focused)) return null;
    if (previewUntil > timestamp) {
      // 表示テストでは、設定した表示・移動開始時間を満たす値から進める。
      return {
        milliseconds: Math.max(previewSettings.thresholdSeconds, previewSettings.bounceThresholdSeconds) * 1000 + timestamp - previewStartedAt,
        settings: previewSettings, preview: true
      };
    }
    if (!snapshot || timestamp > snapshot.state.validUntil) return null;
    const projected = core.advanceState(snapshot.state, timestamp, snapshot.settings);
    if (projected.mode !== "watching" || !projected.thresholdReached || !snapshot.settings.enabled) return null;
    return { milliseconds: projected.balanceMilliseconds, settings: snapshot.settings, preview: false };
  }

  function moveOverlay(timestamp) {
    // 実フレーム間隔に応じて移動し、画面端で縦横の方向を反転する。
    animationIdentifier = 0;
    const display = getDisplayState();
    if (!display) return hideOverlay();
    const bounds = getMovementBounds();
    const shouldBounce = core.shouldBounce(display.milliseconds, display.settings, reducedMotion.matches);
    // 長い描画停止で飛び回らないよう、移動に使う時間差を100ミリ秒までに制限する。
    const elapsedSeconds = previousFrameAt ? Math.min(0.1, Math.max(0, timestamp - previousFrameAt) / 1000) : 0;
    previousFrameAt = timestamp;
    if (shouldBounce) {
      horizontalPosition += horizontalDirection * 76 * elapsedSeconds;
      verticalPosition += verticalDirection * 51 * elapsedSeconds;
      let reflected = false;
      if (horizontalPosition < 12 || horizontalPosition > bounds.maximumHorizontal) {
        horizontalPosition = Math.max(12, Math.min(bounds.maximumHorizontal, horizontalPosition));
        horizontalDirection *= -1;
        reflected = true;
      }
      if (verticalPosition < 12 || verticalPosition > bounds.maximumVertical) {
        verticalPosition = Math.max(12, Math.min(bounds.maximumVertical, verticalPosition));
        verticalDirection *= -1;
        reflected = true;
      }
      // 角で縦横が同時に反射した場合も、色の変更は1回にまとめる。
      if (reflected) changeBounceColor();
    } else {
      horizontalPosition = Math.max(12, bounds.maximumHorizontal - getFixedHorizontalOffset());
      verticalPosition = bounds.maximumVertical;
      timerColor = fixedTimerColor;
      timerValue.style.color = timerColor;
    }
    overlayHost.style.setProperty("transform", `translate3d(${horizontalPosition}px, ${verticalPosition}px, 0)`, "important");
    if (shouldBounce) animationIdentifier = requestAnimationFrame(moveOverlay);
  }

  function render() {
    // 表示条件を満たす間だけ、数値と表示内容を更新する。
    const display = getDisplayState();
    if (!display) return hideOverlay();
    createOverlay();
    timerValue.textContent = core.formatDuration(display.milliseconds);
    // 指定サイズを基本とし、小さい画面では数字がはみ出さない寸法まで縮める。
    const fittedSize = Math.min(display.settings.timerSizePixels, (innerWidth - 36) / (timerValue.textContent.length * 0.7), (innerHeight - 36) / 1.3);
    timerValue.style.fontSize = `${Math.max(8, fittedSize)}px`;
    overlayHost.style.setProperty("display", "block", "important");
    if (!overlayHost.matches(":popover-open")) {
      // トップレイヤーを使い、YouTubeの全画面表示にも重ねる。
      try { overlayHost.showPopover(); } catch { /* 遷移中は次の描画で再試行する。 */ }
    }
    if (!animationIdentifier) animationIdentifier = requestAnimationFrame(moveOverlay);
  }

  async function sendHeartbeat() {
    // 前面ページから5秒ごとに状態を確認し、休止した背景処理を再開する。
    if (disconnected || heartbeatPending || document.visibilityState !== "visible" || !document.hasFocus()) return;
    heartbeatPending = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "heartbeat" });
      if (response?.deactivate) deactivate();
    } catch {
      if (!chrome.runtime?.id) {
        deactivate();
      }
    } finally {
      heartbeatPending = false;
    }
  }

  function deactivate() {
    // 対象から外れたページの表示・イベント・定期確認を終了する。
    disconnected = true;
    clearInterval(heartbeatIdentifier);
    clearInterval(renderIdentifier);
    hideOverlay();
    overlayHost?.remove();
    globalThis.unitodoFocusMonitorLoaded = false;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    document.removeEventListener("fullscreenchange", handleFullscreenChange);
    window.removeEventListener("focus", handleVisibilityChange);
    window.removeEventListener("blur", handleVisibilityChange);
    window.removeEventListener("pageshow", handleVisibilityChange);
    window.removeEventListener("pagehide", hideOverlay);
    if (chrome.runtime?.id) chrome.runtime.onMessage.removeListener(receiveBackgroundMessage);
  }

  function handleVisibilityChange() {
    // タブを離れた直後に表示を消し、戻ったら再確認する。
    render();
    void sendHeartbeat();
  }

  function handleFullscreenChange() {
    // 全画面切り替え後にタイマーを最前面へ再配置する。
    hideOverlay();
    if (overlayHost) (document.fullscreenElement ?? document.documentElement).append(overlayHost);
    render();
    void sendHeartbeat();
  }

  // 動画のページ内移動やタブ切り替えでも同じ計測表示を維持する。
  function receiveBackgroundMessage(message) {
    // 背景処理の確定状態、非表示指示、プレビュー要求を受け取る。
    if (message.type === "snapshot") snapshot = message.snapshot;
    if (message.type === "hide-overlay") {
      snapshot = null;
      previewUntil = 0;
    }
    if (message.type === "preview") {
      previewStartedAt = Date.now();
      previewUntil = previewStartedAt + 10000;
      previewSettings = core.normalizeSettings(message.settings);
    }
    if (message.type === "deactivate") return deactivate();
    render();
  }
  chrome.runtime.onMessage.addListener(receiveBackgroundMessage);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  window.addEventListener("focus", handleVisibilityChange);
  window.addEventListener("blur", handleVisibilityChange);
  window.addEventListener("pageshow", handleVisibilityChange);
  window.addEventListener("pagehide", hideOverlay);
  heartbeatIdentifier = setInterval(sendHeartbeat, 5000);
  renderIdentifier = setInterval(render, 250);
  void sendHeartbeat();
})();
