const ADDON_NAME = "CatJamSynced";
const HANDLE_URL = "http://localhost:2007/get_handle?name=";
const DEFAULT_VIDEO_URL = "catjam.webm";
const VIDEO_ID = "catjam-webm";
const FALLBACK_HOST_ID = "catjam-fallback-host";
const LIKE_HOST_ID = "catjam-like-host";
const FALLBACK_IMG_ID = "catjam-fallback-image";

const SELECTORS = {
  pulse: [
    'div[data-test-id="VIBE_ANIMATION"]',
    '[data-test-id="VIBE_ANIMATION"]',
    '[data-test-id*="VIBE"]',
    '[data-test-id*="PULSE"]',
    '[class*="vibe"]',
    '[class*="pulse"]'
  ],
  bottomPlayer: [
    ".main-nowPlayingBar-right",
    ".now-playing-bar__right",
    ".player-controls__right",
    '[data-test-id="PLAYER_CONTROLS_RIGHT"]',
    ".bar-below-player .right",
    ".player-controls"
  ],
  leftLibraryA: ".main-yourLibraryX-libraryItemContainer",
  leftLibraryB: ".main-yourLibraryX-library"
};

const DEBUG_LOG = true; // Temporary debug switch
const DEBUG_LOG_INTERVAL_MS = 2000;

const state = {
  settings: {
    enabled: true,
    followPulse: true,
    fallbackRate: 100,
    customUrl: ""
  },
  pulseElement: null,
  pulseBound: false,
  refreshTimer: null,
  fastTimer: null,
  currentTrackKey: "",
  lastTrackChangeTs: 0,
  lastDebugLogTs: 0
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickItemValue(item) {
  if (item.type === "button") return item.bool;
  if (item.type === "color") return item.input;
  if (item.type === "selector") return item.selected;
  if (item.type === "slider") return item.value;
  if (item.type === "file") return item.filePath;
  if (item.type === "text") return item.buttons || [];

  if (item.bool !== undefined) return item.bool;
  if (item.input !== undefined) return item.input;
  if (item.selected !== undefined) return item.selected;
  if (item.value !== undefined) return item.value;
  if (item.filePath !== undefined) return item.filePath;
  return undefined;
}

function transformHandleData(data) {
  const result = {};
  for (const section of data.sections || []) {
    for (const item of section.items || []) {
      if (item.type === "text" && Array.isArray(item.buttons)) {
        result[item.id] = {};
        for (const button of item.buttons) {
          result[item.id][button.id] = {
            value: button.text,
            default: button.defaultParameter
          };
        }
      } else {
        result[item.id] = {
          value: pickItemValue(item),
          default: item.defaultParameter
        };
      }
    }
  }
  return result;
}

async function getSettings(name) {
  try {
    const response = await fetch(`${HANDLE_URL}${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const data = payload && payload.data;
    if (!data || !Array.isArray(data.sections)) return null;
    return transformHandleData(data);
  } catch (error) {
    console.warn("[CATJAM] Failed to read PulseSync settings:", error);
    return null;
  }
}

function getValue(settings, id, fallback) {
  if (!settings || !settings[id]) return fallback;
  const val = settings[id].value;
  if (val === undefined || val === null) return fallback;
  return val;
}

function getTextValue(settings, id, buttonId, fallback) {
  if (!settings || !settings[id] || !settings[id][buttonId]) return fallback;
  const val = settings[id][buttonId].value;
  if (val === undefined || val === null) return fallback;
  return val;
}

function normalizeSettings(settings) {
  return {
    enabled: !!getValue(settings, "enabled", state.settings.enabled),
    followPulse: !!getValue(settings, "followPulse", state.settings.followPulse),
    fallbackRate: Number(getValue(settings, "fallbackRate", state.settings.fallbackRate)) || 100,
    customUrl: String(getTextValue(settings, "customUrl", "url", "") || "")
  };
}

function getAudioElement() {
  return deepQueryFirst("audio") || deepQueryFirst("video");
}

function deepQueryFirst(selector, root = document) {
  try {
    const direct = root.querySelector(selector);
    if (direct) return direct;
  } catch (_error) {}

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node.shadowRoot) {
      const found = deepQueryFirst(selector, node.shadowRoot);
      if (found) return found;
    }
    node = walker.nextNode();
  }
  return null;
}

function deepCollectAnimated(root = document, out = []) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;
  while (node) {
    if (node.nodeType === 1) {
      try {
        const style = window.getComputedStyle(node);
        const dur = parseAnimationDurationMs(style.animationDuration);
        if (style.animationName && style.animationName !== "none" && dur > 0) {
          out.push({
            el: node,
            dur,
            style,
            iterationCount: String(style.animationIterationCount || ""),
            animationName: String(style.animationName || "")
          });
        }
      } catch (_error) {}
    }
    if (node.shadowRoot) {
      deepCollectAnimated(node.shadowRoot, out);
    }
    node = walker.nextNode();
  }
  return out;
}

function findPlayPauseButton() {
  const selectors = [
    '[data-test-id="PLAYER_PLAY_PAUSE_BUTTON"]',
    '[data-test-id="PLAYER_PLAY_BUTTON"]',
    '[data-test-id="PLAYER_PAUSE_BUTTON"]',
    '[data-test-id="play-pause"]',
    '[data-test-id*="PLAY_PAUSE"]',
    'button[aria-label*="Пауза"]',
    'button[aria-label*="Воспроизвести"]',
    'button[aria-label*="Pause"]',
    'button[aria-label*="Play"]'
  ];
  for (const selector of selectors) {
    const el = deepQueryFirst(selector);
    if (el) return el;
  }
  return null;
}

function isPlayingFromControls() {
  const btn = findPlayPauseButton();
  if (!btn) return null;

  const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""}`.toLowerCase();
  if (label.includes("воспроизвести") || label.includes("play")) return false;
  if (label.includes("пауза") || label.includes("pause")) return true;

  const dataId = String(btn.getAttribute("data-test-id") || "").toUpperCase();
  if (dataId.includes("PLAY_BUTTON")) return false;
  if (dataId.includes("PAUSE_BUTTON")) return true;

  const innerPlay = btn.querySelector('[data-test-id*="PLAY"], [class*="play"], [aria-label*="Play"], [aria-label*="Воспроизвести"]');
  const innerPause = btn.querySelector('[data-test-id*="PAUSE"], [class*="pause"], [aria-label*="Pause"], [aria-label*="Пауза"]');
  if (innerPause && !innerPlay) return true;
  if (innerPlay && !innerPause) return false;

  const text = (btn.textContent || "").trim();
  if (text.includes("▶")) return false;
  if (text.includes("❚❚") || text.includes("⏸")) return true;

  return null;
}

function isAudioPlaying() {
  if (navigator.mediaSession && navigator.mediaSession.playbackState) {
    const state = navigator.mediaSession.playbackState;
    if (state === "playing") return true;
    if (state === "paused") return false;
  }

  const controlState = isPlayingFromControls();
  if (controlState !== null) return controlState;

  const audio = getAudioElement();
  if (audio) return !audio.paused && !audio.ended;

  return false;
}

function getVideoUrl() {
  const custom = state.settings.customUrl.trim();
  return custom || DEFAULT_VIDEO_URL;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeTrackText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(feat|ft)\.?\b.*$/i, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function buildTrackKey(title, artist) {
  if (!title && !artist) return "";
  return `${title}__${artist}`;
}

function readTrackInfo() {
  const titleSelectors = [
    '[data-test-id="PLAYER_TITLE"]',
    '[data-test-id="TRACK_TITLE"]',
    ".player-track__title",
    ".track-title",
    ".d-track__title"
  ];
  const artistSelectors = [
    '[data-test-id="PLAYER_ARTIST"]',
    '[data-test-id="TRACK_ARTIST"]',
    ".player-track__artists",
    ".track-artists",
    ".d-track__artists"
  ];

  const readText = (selectors) => {
    for (const selector of selectors) {
      const el = deepQueryFirst(selector);
      if (el && el.textContent) {
        const text = el.textContent.trim();
        if (text) return text;
      }
    }
    return "";
  };

  const title = readText(titleSelectors);
  const artist = readText(artistSelectors);
  const key = buildTrackKey(title, artist);
  return { title, artist, key };
}

function parseAnimationDurationMs(value) {
  if (!value) return 0;
  const first = String(value).split(",")[0].trim();
  if (first.endsWith("ms")) {
    return Number(first.replace("ms", "").trim()) || 0;
  }
  if (first.endsWith("s")) {
    return (Number(first.replace("s", "").trim()) || 0) * 1000;
  }
  return 0;
}

function getTargetPlaybackRate() {
  return clamp(state.settings.fallbackRate / 100, 0.25, 3);
}

function onTrackChanged() {
  // Keep last pulse BPM between tracks; PulseSync pulse element may survive/lag behind track switches.
  state.lastTrackChangeTs = performance.now();

  // Force pulse listener rebind after track changes (UI often re-renders controls/pulse node).
  if (state.pulseElement && state.pulseBound) {
    try {
      state.pulseElement.removeEventListener("animationiteration", syncCatToPulse);
    } catch (_error) {}
  }
  state.pulseElement = null;
  state.pulseBound = false;

  const video = document.getElementById(VIDEO_ID);
  if (video) {
    video.currentTime = 0;
    applyPlaybackRate(video);
    if (isAudioPlaying()) {
      video.play().catch(() => {});
    }
  }
}

function checkTrackChange() {
  const info = readTrackInfo();
  const key = info.key;
  if (!key) return;
  if (!state.currentTrackKey) {
    state.currentTrackKey = key;
    onTrackChanged();
    return;
  }
  if (key !== state.currentTrackKey) {
    state.currentTrackKey = key;
    onTrackChanged();
  }
}

function applyPlaybackRate(video) {
  if (!video) return;
  const target = getTargetPlaybackRate();
  if (!Number.isFinite(target)) return;
  video.playbackRate = target;
}

function maybeDebugLog() {
  if (!DEBUG_LOG) return;
  const now = performance.now();
  if (now - state.lastDebugLogTs < DEBUG_LOG_INTERVAL_MS) return;
  state.lastDebugLogTs = now;

  const video = document.getElementById(VIDEO_ID);
  const rate = video ? Number(video.playbackRate || 0).toFixed(3) : "n/a";
  const playing = isAudioPlaying();
  const pulseEl = state.pulseElement;
  const pulseDur = pulseEl ? parseAnimationDurationMs(window.getComputedStyle(pulseEl).animationDuration).toFixed(0) : "n/a";

  console.log(
    `[CATJAM DEBUG] playing=${playing} rate=${rate} pulseFound=${!!pulseEl} pulseDurMs=${pulseDur}`
  );
}

function getTargetSelectors() {
  return SELECTORS.bottomPlayer;
}

function getVideoStyle() {
  return "width:66px;height:66px;pointer-events:none;z-index:9999;";
}

function findLikeButton() {
  const candidates = [
    '[data-test-id="LIKE_BUTTON"]',
    'button[aria-label*="РќСЂР°РІ"]',
    'button[aria-label*="Р›Р°Р№Рє"]',
    'button[aria-label*="Like"]',
    'button[title*="РќСЂР°РІ"]',
    'button[title*="Р›Р°Р№Рє"]',
    'button[title*="Like"]',
    '[data-test-id*="like"]',
    '[class*="like"] button',
    'button:has(svg path[d*="M"])'
  ];

  for (const selector of candidates) {
    try {
      const node = deepQueryFirst(selector);
      if (node) return node;
    } catch (_error) {
      // Ignore unsupported selectors in older engines.
    }
  }
  return null;
}

function isOtherWindowOpen() {
  const selectors = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[data-test-id*="MODAL"]',
    '[data-test-id*="POPUP"]',
    ".Modal",
    ".modal",
    ".popup",
    ".dialog",
    ".overlay"
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const style = window.getComputedStyle(el);
    const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    if (visible) return true;
  }

  return false;
}

function findPulseElement() {
  for (const selector of SELECTORS.pulse) {
    const el = deepQueryFirst(selector);
    if (!el) continue;
    const style = window.getComputedStyle(el);
    const iteration = String(style.animationIterationCount || "");
    const hasAnimation =
      style.animationName &&
      style.animationName !== "none" &&
      parseAnimationDurationMs(style.animationDuration) > 0 &&
      (iteration === "infinite" || iteration === "Infinity");
    if (hasAnimation) return el;
  }

  // Last-resort scan: pick animated element with vibe/pulse-like attributes.
  const allAnimated = deepCollectAnimated();

  // Prefer fast looping animations in/near bottom player.
  const preferred = allAnimated
    .filter((item) => item.dur >= 250 && item.dur <= 1500)
    .filter((item) => item.iterationCount === "infinite" || item.iterationCount === "Infinity")
    .sort((a, b) => a.dur - b.dur);

  for (const item of preferred) {
    const el = item.el;
    const testId = (el.getAttribute("data-test-id") || "").toLowerCase();
    const cls = (el.className || "").toString().toLowerCase();
    const inPlayer = !!(el.closest && (el.closest(".main-nowPlayingBar-right") || el.closest('[data-test-id*="PLAYER"]')));
    const inLikeArea = !!(el.closest && (el.closest('[data-test-id="LIKE_BUTTON"]') || el.closest('[data-test-id*="LIKE"]')));
    const vibeLikeSignature =
      testId.includes("vibe") || testId.includes("pulse") || cls.includes("vibe") || cls.includes("pulse");
    if (!inLikeArea && vibeLikeSignature) {
      return el;
    }
    if (!inLikeArea && inPlayer && (testId.includes("vibe") || testId.includes("pulse"))) {
      return el;
    }
  }

  return null;
}

async function waitForElement(selectors, attempts = 30, interval = 150) {
  for (let i = 0; i < attempts; i += 1) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    await sleep(interval);
  }
  return null;
}

function removeVideo() {
  const video = document.getElementById(VIDEO_ID);
  if (video) video.remove();
  const fallbackHost = document.getElementById(FALLBACK_HOST_ID);
  if (fallbackHost) fallbackHost.remove();
  const likeHost = document.getElementById(LIKE_HOST_ID);
  if (likeHost) likeHost.remove();
  const fallbackImg = document.getElementById(FALLBACK_IMG_ID);
  if (fallbackImg) fallbackImg.remove();
}

function ensureFallbackCat(host) {
  let cat = document.getElementById(FALLBACK_IMG_ID);
  if (!cat) {
    cat = document.createElement("div");
    cat.id = FALLBACK_IMG_ID;
    cat.className = "catjam-fallback-cat";
    cat.textContent = "рџђ±";
  }
  if (host && cat.parentElement !== host) {
    host.appendChild(cat);
  }
  return cat;
}

function hideFallbackCat() {
  const cat = document.getElementById(FALLBACK_IMG_ID);
  if (cat) cat.remove();
}

function ensureContainerPositioning() {
  const libs = [document.querySelector(SELECTORS.leftLibraryA), document.querySelector(SELECTORS.leftLibraryB)];
  for (const lib of libs) {
    if (lib && getComputedStyle(lib).position === "static") {
      lib.style.position = "relative";
    }
  }
}

async function ensureVideo() {
  ensureContainerPositioning();

  if (!state.settings.enabled) {
    removeVideo();
    return null;
  }

  if (isOtherWindowOpen()) {
    removeVideo();
    return null;
  }

  let video = document.getElementById(VIDEO_ID);
  if (!video) {
    video = document.createElement("video");
    video.id = VIDEO_ID;
    video.className = "catjam-video";
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.addEventListener("error", () => {
      const host = video.parentElement;
      ensureFallbackCat(host);
      video.style.display = "none";
    });
    video.addEventListener("loadeddata", () => {
      hideFallbackCat();
      video.style.display = "";
    });
  }
  const likeButton = findLikeButton();
  if (!likeButton) {
    removeVideo();
    return null;
  }
  const existingHost = document.getElementById(FALLBACK_HOST_ID);
  if (existingHost) existingHost.remove();
  const likeHost = ensureLikeHost();
  positionLikeHost(likeHost, likeButton);
  video.classList.remove("catjam-inline");
  if (likeHost.firstChild !== video) {
    likeHost.replaceChildren(video);
  }
  const mountHost = likeHost;

  const nextUrl = getVideoUrl();
  applyPlaybackRate(video);
  video.style.cssText = getVideoStyle();

  if (!nextUrl) {
    ensureFallbackCat(mountHost);
    video.removeAttribute("src");
    video.style.display = "none";
    return video;
  }

  hideFallbackCat();
  if (video.src !== nextUrl) {
    video.src = nextUrl;
  }

  if (isAudioPlaying()) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }

  return video;
}

function ensureFallbackHost() {
  let host = document.getElementById(FALLBACK_HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = FALLBACK_HOST_ID;
    document.body.appendChild(host);
  }
  return host;
}

function ensureLikeHost() {
  let host = document.getElementById(LIKE_HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = LIKE_HOST_ID;
    document.body.appendChild(host);
  }
  return host;
}

function positionLikeHost(host, likeButton) {
  const rect = likeButton.getBoundingClientRect();
  const size = 66;
  host.style.position = "fixed";
  host.style.left = `${Math.round(rect.right + 10)}px`;
  host.style.top = `${Math.round(rect.top + (rect.height - size) / 2)}px`;
  host.style.width = `${size}px`;
  host.style.height = `${size}px`;
  host.style.pointerEvents = "none";
  host.style.zIndex = "9999";
}

function resyncCatAnimation() {
  const video = document.getElementById(VIDEO_ID);
  const fallbackCat = document.getElementById(FALLBACK_IMG_ID);
  if (!isAudioPlaying()) return;

  // Keep cat in tempo; do not hard-reset each beat to avoid "same speed" look.
  if (video && video.style.display !== "none") {
    applyPlaybackRate(video);
    video.play().catch(() => {});
  }
  if (fallbackCat) {
    fallbackCat.classList.remove("catjam-pulse");
    void fallbackCat.offsetWidth;
    fallbackCat.classList.add("catjam-pulse");
  }
}

function syncCatToPulse(event) {
  if (!state.settings.followPulse) return;
  if (!state.pulseElement || !state.pulseElement.isConnected) return;
  if (event && event.currentTarget && event.currentTarget !== state.pulseElement) return;
  resyncCatAnimation();
}

function bindPulseSync() {
  const pulse = findPulseElement();

  if (state.pulseElement && state.pulseElement !== pulse && state.pulseBound) {
    state.pulseElement.removeEventListener("animationiteration", syncCatToPulse);
    state.pulseBound = false;
  }

  state.pulseElement = pulse || null;

  if (!pulse) return;
  if (state.pulseBound) return;
  pulse.addEventListener("animationiteration", syncCatToPulse);
  state.pulseBound = true;
}

function syncPlayPause() {
  const video = document.getElementById(VIDEO_ID);
  if (!video) return;

  const playing = isAudioPlaying();
  if (!playing) {
    video.pause();
    return;
  }

  applyPlaybackRate(video);
  video.play().catch(() => {});
}

function bindAudioState() {
  const audio = getAudioElement();
  if (!audio) return;

  if (audio.__catJamBound) return;
  audio.__catJamBound = true;

  audio.addEventListener("play", syncPlayPause);
  audio.addEventListener("pause", syncPlayPause);
  audio.addEventListener("seeking", resyncCatAnimation);
}

async function tick() {
  const fresh = await getSettings(ADDON_NAME);
  if (fresh) {
    state.settings = normalizeSettings(fresh);
  }
  checkTrackChange();

  await ensureVideo();
  bindPulseSync();
  bindAudioState();
  syncPlayPause();
}

function fastTick() {
  if (!state.settings.enabled || isOtherWindowOpen()) {
    removeVideo();
    return;
  }
  checkTrackChange();
  bindPulseSync();

  const video = document.getElementById(VIDEO_ID);
  if (!video) return;

  const likeButton = findLikeButton();
  if (!likeButton) {
    removeVideo();
    return;
  }

  const likeHost = ensureLikeHost();
  positionLikeHost(likeHost, likeButton);
  if (likeHost.firstChild !== video) {
    likeHost.replaceChildren(video);
  }
  applyPlaybackRate(video);
  syncPlayPause();
  maybeDebugLog();
}

(async function start() {
  await tick();
  state.refreshTimer = setInterval(tick, 2000);
  state.fastTimer = setInterval(fastTick, 250);
})();
