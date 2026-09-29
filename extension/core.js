(function initializeFocusMonitorCore() {
  // 背景処理・ページ表示・テストで共有する純粋な計測処理を登録する。
  "use strict";

  // 初期設定と、閲覧を確認できなくなった場合の加算上限を保持する。
  const defaultSettings = Object.freeze({
    enabled: true,
    thresholdSeconds: 60,
    recoveryRate: 1,
    bounceEnabled: true,
    // 移動を始めるタイマーの値を秒単位で保持する。
    bounceThresholdSeconds: 300,
    timerSizePixels: 48,
    monitorSocial: true,
    monitorVideo: true,
    customSites: Object.freeze([])
  });
  const maximumObservationGap = 15000;
  const observationLifetime = 12000;

  function normalizeSiteInput(value) {
    // 入力されたURLやドメインを、登録用のホスト名へ揃える。
    const input = typeof value === "string" ? value.trim() : "";
    if (!input || /[\s*]/u.test(input)) throw new Error("サイトのURLまたはドメインを入力してください。");
    let location;
    try {
      location = new URL(input.includes("://") ? input : `https://${input}`);
    } catch {
      throw new Error("正しいURLまたはドメインを入力してください。");
    }
    const hostname = location.hostname.replace(/\.$/u, "").replace(/^www\./u, "");
    if (!["https:", "http:"].includes(location.protocol) || location.username || location.password || location.port ||
        hostname.length > 253 || !hostname.includes(".") || /^[\d.]+$/u.test(hostname) ||
        hostname.endsWith(".localhost") || !hostname.split(".").every(function isDomainLabel(label) {
          // ドメインの各区切りが、英数字とハイフンで構成されていることを確認する。
          return /^(?:[a-z\d]|[a-z\d][a-z\d-]{0,61}[a-z\d])$/u.test(label);
        })) {
      throw new Error("ポート指定のない通常のWebサイトを入力してください。");
    }
    return hostname;
  }

  function belongsToDomain(hostname, domain) {
    // 完全一致または正しいサブドメイン境界を確認する。
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }

  function getSitePattern(domain) {
    // HTTPとHTTPSの両方に使う、ドメイン単位のChrome権限を作る。
    return `*://*.${domain}/*`;
  }

  function validateNewSite(domain, settings) {
    // 既存サイトと重なる登録や、上限を超える登録を防ぐ。
    if (settings.customSites.length >= 50) throw new Error("追加サイトは50件まで登録できます。");
    for (const registered of ["x.com", "twitter.com", "youtube.com", ...settings.customSites]) {
      if (belongsToDomain(domain, registered) || belongsToDomain(registered, domain)) {
        throw new Error(`${registered} はすでに対象サイトに含まれています。`);
      }
    }
  }

  function normalizeSettings(candidate = {}) {
    // 保存値や入力値を、利用可能な設定の範囲へ揃える。
    const source = candidate && typeof candidate === "object" ? candidate : {};
    const threshold = Number(source.thresholdSeconds ?? defaultSettings.thresholdSeconds);
    const bounceThreshold = Number(source.bounceThresholdSeconds ?? defaultSettings.bounceThresholdSeconds);
    const recovery = Number(source.recoveryRate ?? defaultSettings.recoveryRate);
    const timerSize = Number(source.timerSizePixels ?? defaultSettings.timerSizePixels);
    const customSites = [];
    for (const candidateSite of Array.isArray(source.customSites) ? source.customSites.slice(0, 50) : []) {
      try {
        const domain = normalizeSiteInput(candidateSite);
        if (!customSites.includes(domain)) customSites.push(domain);
      } catch { /* 不正な保存値は対象へ含めない。 */ }
    }
    return {
      enabled: typeof source.enabled === "boolean" ? source.enabled : defaultSettings.enabled,
      thresholdSeconds: Number.isFinite(threshold) ? Math.min(3600, Math.max(10, Math.round(threshold))) : 60,
      recoveryRate: [0.5, 1, 2].includes(recovery) ? recovery : 1,
      bounceEnabled: typeof source.bounceEnabled === "boolean" ? source.bounceEnabled : true,
      bounceThresholdSeconds: Number.isFinite(bounceThreshold)
        ? Math.min(3600, Math.max(10, Math.round(bounceThreshold))) : defaultSettings.bounceThresholdSeconds,
      timerSizePixels: Number.isFinite(timerSize) ? Math.min(160, Math.max(16, Math.round(timerSize))) : 48,
      monitorSocial: typeof source.monitorSocial === "boolean" ? source.monitorSocial : true,
      monitorVideo: typeof source.monitorVideo === "boolean" ? source.monitorVideo : true,
      customSites
    };
  }

  function identifySite(address, settings = defaultSettings) {
    // 標準サイトと登録したドメインだけを対象サイトとして判定する。
    try {
      const location = new URL(address);
      if (!["https:", "http:"].includes(location.protocol)) return null;
      const hostname = location.hostname;
      if (location.protocol === "https:") {
        if (settings.monitorSocial && (belongsToDomain(hostname, "x.com") || belongsToDomain(hostname, "twitter.com"))) return "X / Twitter";
        if (settings.monitorVideo && belongsToDomain(hostname, "youtube.com")) return "YouTube";
      }
      for (const domain of settings.customSites ?? []) {
        if (belongsToDomain(hostname, domain)) return domain;
      }
      return null;
    } catch {
      return null;
    }
  }

  function shouldBounce(milliseconds, settings, reducedMotion = false) {
    // 秒単位の開始設定をミリ秒へ換算し、表示中の残高で移動の可否を判定する。
    const thresholdSeconds = settings.bounceThresholdSeconds ?? defaultSettings.bounceThresholdSeconds;
    return settings.bounceEnabled && !reducedMotion && milliseconds >= thresholdSeconds * 1000;
  }

  function parseActiveEntry(body) {
    // 停止時の空本文・nullと、実行中の作業ログを読み取る。
    if (typeof body !== "string") throw new Error("UniToDoの応答形式を確認してください。");
    const entry = body.trim() ? JSON.parse(body) : null;
    if (entry === null) return null;
    if (typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.identifier !== "string" || !entry.identifier ||
        typeof entry.title !== "string" || typeof entry.startAt !== "string" ||
        !Number.isFinite(Date.parse(entry.startAt)) || entry.endAt !== null) {
      throw new Error("UniToDoのAPI形式が対応する形式と異なります。");
    }
    if (entry.voidedAt) return null;
    return {
      key: JSON.stringify([entry.identifier, entry.taskIdentifier ?? null]),
      title: entry.title.slice(0, 300)
    };
  }

  function createState(timestamp = Date.now()) {
    // 新しいブラウザセッションの計測状態を作る。
    return {
      balanceMilliseconds: 0,
      thresholdReached: false,
      updatedAt: timestamp,
      validUntil: timestamp,
      mode: "paused",
      workKey: null,
      workTitle: "",
      connected: false,
      connectionError: "",
      checkedAt: 0,
      activeTabIdentifier: null,
      activeSite: null,
      focused: false,
      locked: false,
      exemptUntil: 0
    };
  }

  function advanceState(previous, timestamp, settings) {
    // 前回の状態から経過時間を加減し、スリープ中の過大加算を防ぐ。
    const state = { ...previous };
    // 閲覧中は実時間を加算し、それ以外は設定倍率でゼロまで減算する。
    const elapsed = Math.max(0, timestamp - state.updatedAt);
    if (state.mode === "watching" && elapsed <= maximumObservationGap) {
      const confirmedElapsed = Math.min(elapsed, Math.max(0, state.validUntil - state.updatedAt));
      state.balanceMilliseconds += confirmedElapsed;
    } else if (state.mode === "recovering") {
      state.balanceMilliseconds = Math.max(0, state.balanceMilliseconds - elapsed * settings.recoveryRate);
    }
    state.updatedAt = timestamp;
    if (state.balanceMilliseconds >= settings.thresholdSeconds * 1000) state.thresholdReached = true;
    if (state.balanceMilliseconds === 0) state.thresholdReached = false;
    return state;
  }

  function reconcileState(previous, observation, settings) {
    // 作業ログ・前面タブ・ロック状態から次の計測方向を決める。
    const state = advanceState(previous, observation.timestamp, settings);
    state.connected = observation.connected;
    state.connectionError = observation.connectionError ?? "";
    state.checkedAt = observation.checkedAt;
    state.activeTabIdentifier = observation.tabIdentifier;
    state.activeSite = observation.site;
    state.focused = observation.focused;
    state.locked = observation.locked;
    state.exemptUntil = observation.exemptUntil ?? 0;

    // 停止または別の作業区間への変更で計測を区切る。通信失敗時は残高を保持する。
    if (observation.connected) {
      const nextKey = observation.work?.key ?? null;
      if (state.workKey !== nextKey) {
        state.balanceMilliseconds = 0;
        state.thresholdReached = false;
      }
      state.workKey = nextKey;
      state.workTitle = observation.work?.title ?? "";
    }
    const working = settings.enabled && state.connected && Boolean(state.workKey);
    const watching = working && state.focused && !state.locked && Boolean(state.activeSite) &&
      state.exemptUntil <= observation.timestamp;
    state.mode = !working ? "paused" : watching ? "watching" : "recovering";
    state.validUntil = observation.timestamp + observationLifetime;
    if (state.balanceMilliseconds >= settings.thresholdSeconds * 1000) state.thresholdReached = true;
    return state;
  }

  function describeState(state, settings, timestamp = Date.now()) {
    // ポップアップに表示する状態名と補足を組み立てる。
    if (!settings.enabled) return { label: "モニター OFF", detail: "計測を一時停止しています。", kind: "muted" };
    if (!state.connected) return { label: "UniToDo 未接続", detail: state.connectionError || "UniToDoを起動すると自動で接続します。", kind: "offline" };
    if (!state.workKey) return { label: "作業タイマー待ち", detail: "UniToDoで作業を開始すると見守ります。", kind: "muted" };
    if (state.exemptUntil > timestamp) return { label: "このタブは除外中", detail: "仕事用の閲覧として、タイマーは減少します。", kind: "calm" };
    if (state.mode === "watching") return { label: `${state.activeSite} を閲覧中`, detail: "対象サイトから離れるとタイマーが減少します。", kind: state.thresholdReached ? "warning" : "watching" };
    if (state.locked) return { label: "画面ロック中", detail: "閲覧時間を加算せず、タイマーを減らしています。", kind: "calm" };
    return { label: state.balanceMilliseconds > 0 ? "集中に復帰中" : "集中しています", detail: `対象サイトを離れている間、毎秒${settings.recoveryRate}秒ずつ減少します。`, kind: "calm" };
  }

  function formatDuration(milliseconds) {
    // ミリ秒を、1時間未満は分秒、それ以上は時分秒へ変換する。
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  globalThis.FocusMonitorCore = Object.freeze({
    defaultSettings, maximumObservationGap, observationLifetime, normalizeSettings,
    normalizeSiteInput, belongsToDomain, getSitePattern, validateNewSite, shouldBounce,
    identifySite, parseActiveEntry, createState, advanceState, reconcileState, describeState, formatDuration
  });
})();
