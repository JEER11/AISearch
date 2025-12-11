const RESULT_SELECTOR = "ytd-video-renderer";
const ATTRIBUTE_ID = "data-ai-semantic-id";
const HIGHLIGHT_CLASS = "ai-semantic-highlight";
const DEFAULT_CONFIG = {
  maxItems: 30,
  minScore: 0.25,
  enableReorder: true,
  showBadges: true,
  imageMode: "balanced",
  enableMusicFilter: true,
  enableBrandFilter: true,
  enableIntentBoost: true,
  enableTemporalBoost: true
};
const STORAGE_DEFAULTS = {
  enabled: true,
  backendUrl: "http://127.0.0.1:5000/search",
  maxItems: DEFAULT_CONFIG.maxItems,
  minScore: 0.25,
  enableReorder: DEFAULT_CONFIG.enableReorder,
  showBadges: DEFAULT_CONFIG.showBadges,
  imageMode: DEFAULT_CONFIG.imageMode,
  enableMusicFilter: DEFAULT_CONFIG.enableMusicFilter,
  enableBrandFilter: DEFAULT_CONFIG.enableBrandFilter,
  enableIntentBoost: DEFAULT_CONFIG.enableIntentBoost,
  enableTemporalBoost: DEFAULT_CONFIG.enableTemporalBoost
};
const NEGATIVE_KEYWORDS = [
  "lyrics",
  "official video",
  "music video",
  "audio",
  "song",
  "remix",
  "cover",
  "vevo",
  "karaoke"
];
const APPLE_BRAND_KEYWORDS = [
  "iphone",
  "ipad",
  "ipod",
  "macbook",
  "macbook pro",
  "macbook air",
  "mac mini",
  "mac studio",
  "mac pro",
  "imac",
  "apple watch",
  "watch",
  "airpods",
  "vision pro",
  "apple event",
  "wwdc",
  "apple silicon",
  "m1",
  "m2",
  "m3",
  "a17",
  "a18",
  "ios",
  "macos",
  "unboxing",
  "review",
  "stock",
  "aapl",
  "earnings",
  "preorder"
];
const APPLE_FRUIT_KEYWORDS = [
  "fruit",
  "orchard",
  "tree",
  "picking",
  "harvest",
  "recipe",
  "cooking",
  "baking",
  "pie",
  "juice",
  "cider",
  "farmer",
  "garden",
  "organic",
  "crisp",
  "sweet",
  "nutrition",
  "vitamin",
  "farm",
  "grow",
  "seed",
  "core",
  "peel",
  "slice",
  "snack",
  "fuji",
  "granny smith",
  "gala",
  "honeycrisp",
  "fruit salad",
  "caramel apple",
  "apple fruit",
  "orchard care"
];

let lastQueryTokens = [];
let lastPayloadHash = "";
let observer = null;
let lastOrderSignature = "";
let settingsReady = false;
let config = { ...DEFAULT_CONFIG };
let imageThresholds = computeImageThresholds(config.imageMode);
let wrongBlacklist = {};

// Frontend caching: store recent search results to speed up re-searches
const resultCache = new Map();
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

function safeSendMessage(message) {
  if (!chrome?.runtime?.id) {
    return;
  }
  try {
    const promise = chrome.runtime.sendMessage(message);
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {});
    }
  } catch (e) {
    // Silently ignore if extension context is gone
  }
}

// Global error handler to suppress extension context errors from old script instances
window.addEventListener('error', (event) => {
  if (event.message && event.message.includes('Extension context invalidated')) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
});

window.addEventListener('unhandledrejection', (event) => {
  if (event.reason && String(event.reason).includes('Extension context invalidated')) {
    event.preventDefault();
    return true;
  }
});

// Only run if runtime is available
if (chrome?.runtime?.id) {
  init().catch(() => {});
}

async function init() {
  console.log("[AIS] Content script starting on", window.location.href);
  
  if (!chrome?.runtime?.id) {
    return;
  }
  
  try {
    injectStyles();
    observeResults();
    await loadSettings();
    await loadBlacklist();
    
    if (chrome?.runtime?.id) {
      chrome.storage.onChanged.addListener(handleStorageChanges);
      chrome.runtime.onMessage.addListener(handleRuntimeMessage);
      console.log("[AIS] Initialized successfully");
      requestAnalysis();
    }
  } catch (error) {
    // Silently fail
  }
}

function loadSettings() {
  return new Promise((resolve) => {
    if (!chrome?.runtime?.id) {
      resolve();
      return;
    }
    try {
      chrome.storage.sync.get(STORAGE_DEFAULTS, (stored) => {
        applySettings(stored);
        settingsReady = true;
        console.log("[AIS] Settings loaded:", config);
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

function handleStorageChanges(changes, area) {
  if (area === "sync") {
    const relevant = {};
    let hasChange = false;
    for (const key of ["maxItems", "minScore", "enableReorder", "showBadges", "imageMode"]) {
      if (Object.prototype.hasOwnProperty.call(changes, key)) {
        relevant[key] = changes[key].newValue;
        hasChange = true;
      }
    }
    if (hasChange) {
      applySettings(relevant);
      lastPayloadHash = "";
      requestAnalysis();
    }
  }

  if (area === "local" && changes.search_feedback) {
    loadBlacklist();
  }
}

function applySettings(partial) {
  const candidate = { ...config, ...partial };
  const maxItems = clamp(Number(candidate.maxItems), 5, 50, DEFAULT_CONFIG.maxItems);
  const minScore = clamp(Number(candidate.minScore), 0, 1, DEFAULT_CONFIG.minScore);
  config = {
    maxItems: Math.round(maxItems),
    minScore,
    enableReorder: typeof candidate.enableReorder === "boolean" ? candidate.enableReorder : DEFAULT_CONFIG.enableReorder,
    showBadges: typeof candidate.showBadges === "boolean" ? candidate.showBadges : DEFAULT_CONFIG.showBadges,
    imageMode: normalizeImageMode(candidate.imageMode),
    enableMusicFilter: typeof candidate.enableMusicFilter === "boolean" ? candidate.enableMusicFilter : DEFAULT_CONFIG.enableMusicFilter,
    enableBrandFilter: typeof candidate.enableBrandFilter === "boolean" ? candidate.enableBrandFilter : DEFAULT_CONFIG.enableBrandFilter,
    enableIntentBoost: typeof candidate.enableIntentBoost === "boolean" ? candidate.enableIntentBoost : DEFAULT_CONFIG.enableIntentBoost,
    enableTemporalBoost: typeof candidate.enableTemporalBoost === "boolean" ? candidate.enableTemporalBoost : DEFAULT_CONFIG.enableTemporalBoost
  };
  imageThresholds = computeImageThresholds(config.imageMode);
}

function observeResults() {
  if (!chrome?.runtime?.id || !document?.body) {
    return;
  }
  try {
    if (observer) {
      observer.disconnect();
    }
    observer = new MutationObserver(() => {
      if (chrome?.runtime?.id) {
        requestAnalysis();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    console.log("[AIS] Mutation observer attached");
  } catch (e) {
    // Fail silently
  }
}

function handleRuntimeMessage(message) {
  switch (message?.type) {
    case "semantic-results":
      // Cache the result using payload hash
      if (message.hash) {
        resultCache.set(message.hash, {
          data: message.data,
          timestamp: Date.now()
        });
      }
      console.log("[AIS] Received", message.data?.ranked?.length || 0, "results");
      if (message.data?.ranked?.length > 0) {
        const scores = message.data.ranked.map(r => r.score?.toFixed(3) || 0);
        console.log("[AIS] Score range:", Math.max(...scores).toFixed(3), "to", Math.min(...scores).toFixed(3));
      }
      applySemanticRanking(message.data);
      break;
    case "semantic-error":
      console.warn("Semantic search error", message.error);
      break;
    case "semantic-disabled":
      clearHighlights();
      break;
    default:
      break;
  }
}

function collectEntries() {
  const nodes = Array.from(document.querySelectorAll(RESULT_SELECTOR)).slice(0, config.maxItems);
  const query = getQuery();
  if (!query || !nodes.length) {
    return null;
  }
  const queryKey = query.toLowerCase();

  const items = nodes
    .map((node, index) => {
      const title = node.querySelector("#video-title")?.textContent?.trim() || "";
      const description = node.querySelector("#description-text")?.textContent?.trim() || "";
      const id = getOrAssignId(node, index);
      
      // Extract publication recency signal (e.g., "2 days ago", "1 month ago")
      // Look in metadata text or metadata elements
      const metadataEl = node.querySelector("span.style-scope.yt-formatted-string");
      const metadata = metadataEl?.textContent?.trim() || "";
      
      return {
        id,
        text: `${title}\n${description}`.trim(),
        title,
        description,
        thumbnail: getThumbnailUrl(node),
        metadata // Pass metadata for temporal scoring
      };
    })
    .filter((item) => item.text.length > 0)
    .filter((item) => !isBlacklisted(queryKey, item.title));

  if (!items.length) {
    return null;
  }

  return { query, items };
}

function requestAnalysis() {
  if (!settingsReady) {
    return;
  }
  
  const payload = collectEntries();
  if (!payload) {
    return;
  }

  lastQueryTokens = tokenize(payload.query);
  const hash = JSON.stringify({ query: payload.query, ids: payload.items.map((item) => item.id) });
  if (hash === lastPayloadHash) {
    return;
  }
  lastPayloadHash = hash;
  lastOrderSignature = "";

  // Check cache first
  const cacheEntry = resultCache.get(hash);
  if (cacheEntry && Date.now() - cacheEntry.timestamp < CACHE_EXPIRY_MS) {
    console.log("[AIS] Using cached results for", payload.query);
    applySemanticRanking(cacheEntry.data);
    return;
  }

  // Cache miss: send to backend
  console.log("[AIS] Sending", payload.items.length, "items for query:", payload.query);
  safeSendMessage({
    type: "semantic-score",
    payload,
    hash
  });
}

function applySemanticRanking(data) {
  if (!data?.ranked?.length) {
    clearHighlights();
    return;
  }

  const entries = new Map(data.ranked.map((item) => [item.id, item]));
  const nodes = Array.from(document.querySelectorAll(`${RESULT_SELECTOR}[${ATTRIBUTE_ID}]`));

  const decorated = nodes.map((node, index) => {
    const id = node.getAttribute(ATTRIBUTE_ID);
    const entry = entries.get(id);
    const passes = entry ? passesFilters(entry) : false;

    if (entry && passes) {
      highlightNode(node, entry);
    } else {
      resetNode(node);
    }

    return {
      node,
      entry,
      passes,
      score: entry?.score ?? -1,
      index
    };
  });

  const passing = decorated.filter(d => d.passes).length;
  console.log(`[AIS] ${passing} of ${decorated.length} videos passed filters (minScore: ${config.minScore})`);
  
  reorderNodes(decorated);
}

function highlightNode(node, entry) {
  const score = entry.score ?? 0;
  if (score < config.minScore) {
    resetNode(node);
    return;
  }

  const color = scoreToColor(score);
  node.classList.add(HIGHLIGHT_CLASS);
  node.style.setProperty("--ai-semantic-score", score.toFixed(3));
  node.style.setProperty("--ai-highlight-color", color);
  node.style.setProperty("--ai-dim-opacity", dimOpacity(score));
  node.style.outline = `3px solid ${color}`;
  node.dataset.aiTextScore = (entry.text_score ?? score).toFixed(3);
  if (typeof entry.image_score === "number") {
    node.dataset.aiImageScore = entry.image_score.toFixed(3);
  } else {
    delete node.dataset.aiImageScore;
  }

  let badge = node.querySelector(".ai-semantic-badge");
  if (!config.showBadges) {
    if (badge) {
      badge.remove();
    }
    return;
  }

  if (!badge) {
    badge = document.createElement("span");
    badge.className = "ai-semantic-badge";
    const titleContainer = node.querySelector("#video-title");
    if (titleContainer?.parentElement) {
      titleContainer.parentElement.insertAdjacentElement("afterbegin", badge);
    } else {
      node.insertAdjacentElement("afterbegin", badge);
    }
  }
  badge.style.backgroundColor = color;
  const imageScore = typeof entry.image_score === "number" ? entry.image_score : null;
  if (imageScore !== null) {
    badge.textContent = `AI match: ${scoreFormat(score)} (img ${scoreFormat(entry.image_score)})`;
  } else {
    badge.textContent = `AI match: ${scoreFormat(score)}`;
  }

  // Add score breakdown tooltip on hover
  addScoreBreakdown(node, entry);

  // Add feedback buttons (thumbs up/down)
  addFeedbackButtons(node, entry);
}

function addFeedbackButtons(node, entry) {
  let feedbackContainer = node.querySelector(".ai-feedback-buttons");
  if (feedbackContainer) {
    return; // Already added
  }

  feedbackContainer = document.createElement("div");
  feedbackContainer.className = "ai-feedback-buttons";
  feedbackContainer.style.cssText = `
    display: flex;
    gap: 4px;
    margin-top: 4px;
    font-size: 11px;
  `;

  const thumbsUp = document.createElement("button");
  thumbsUp.textContent = "👍 Good";
  thumbsUp.style.cssText = `
    padding: 2px 4px;
    background: rgba(16, 185, 129, 0.2);
    border: 1px solid #10b981;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
  `;
  thumbsUp.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    logFeedback(entry, "helpful");
    thumbsUp.style.background = "#10b981";
    thumbsUp.style.color = "white";
  };

  const thumbsDown = document.createElement("button");
  thumbsDown.textContent = "👎 Wrong";
  thumbsDown.style.cssText = `
    padding: 2px 4px;
    background: rgba(239, 68, 68, 0.2);
    border: 1px solid #ef4444;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
  `;
  thumbsDown.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    logFeedback(entry, "wrong");
    thumbsDown.style.background = "#ef4444";
    thumbsDown.style.color = "white";
  };

  feedbackContainer.appendChild(thumbsUp);
  feedbackContainer.appendChild(thumbsDown);

  const badge = node.querySelector(".ai-semantic-badge");
  if (badge && badge.parentElement) {
    badge.parentElement.appendChild(feedbackContainer);
  } else {
    node.insertAdjacentElement("afterbegin", feedbackContainer);
  }
}

function logFeedback(entry, feedbackType) {
  safeSendMessage({
    type: "log-feedback",
    payload: {
      query: lastQueryTokens.join(" "),
      resultId: entry.id,
      title: entry.title,
      description: entry.description || "",
      feedback: feedbackType
    }
  });
}

function addScoreBreakdown(node, entry) {
  let breakdown = node.querySelector(".ai-score-breakdown");
  if (breakdown) {
    return; // Already added
  }

  breakdown = document.createElement("div");
  breakdown.className = "ai-score-breakdown";
  breakdown.style.cssText = `
    display: none;
    position: absolute;
    background: #1f2937;
    color: #e5e7eb;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 11px;
    line-height: 1.4;
    white-space: nowrap;
    z-index: 10000;
    border: 1px solid #4b5563;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;

  const textScore = (entry.text_score ?? entry.score ?? 0);
  const imageScore = typeof entry.image_score === "number" ? entry.image_score : null;
  const finalScore = entry.score ?? 0;

  let breakdownText = `Final: ${scoreFormat(finalScore)}\n`;
  breakdownText += `Text: ${scoreFormat(textScore)}\n`;
  if (imageScore !== null) {
    breakdownText += `Image: ${scoreFormat(imageScore)}\n`;
  }
  breakdownText += `---\nWeights: 60% text, 40% img`;

  breakdown.textContent = breakdownText;
  node.style.position = "relative";
  node.appendChild(breakdown);

  // Show breakdown on hover
  node.addEventListener("mouseenter", () => {
    breakdown.style.display = "block";
    const rect = node.getBoundingClientRect();
    breakdown.style.top = "-60px";
    breakdown.style.left = "0";
  });

  node.addEventListener("mouseleave", () => {
    breakdown.style.display = "none";
  });
}

function resetNode(node) {
  node.classList.remove(HIGHLIGHT_CLASS);
  node.style.removeProperty("--ai-semantic-score");
  node.style.removeProperty("--ai-highlight-color");
  node.style.removeProperty("--ai-dim-opacity");
  node.style.removeProperty("outline");
  const badge = node.querySelector(".ai-semantic-badge");
  if (badge) {
    badge.remove();
  }
}

function clearHighlights() {
  document.querySelectorAll(`${RESULT_SELECTOR}.${HIGHLIGHT_CLASS}`).forEach((node) => resetNode(node));
}

function getOrAssignId(node, index) {
  if (!node.hasAttribute(ATTRIBUTE_ID)) {
    node.setAttribute(ATTRIBUTE_ID, `result-${Date.now()}-${index}`);
  }
  return node.getAttribute(ATTRIBUTE_ID);
}

function getQuery() {
  const url = new URL(window.location.href);
  return url.searchParams.get("search_query") || url.searchParams.get("q") || document.title.replace(" - YouTube", "");
}

function injectStyles() {
  if (document.getElementById("ai-semantic-style")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "ai-semantic-style";
  style.textContent = `
    ${RESULT_SELECTOR}.${HIGHLIGHT_CLASS} {
      position: relative;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15), 0 10px 24px rgba(0, 0, 0, 0.25);
      transition: outline 0.2s ease, box-shadow 0.2s ease;
    }
    ${RESULT_SELECTOR}.${HIGHLIGHT_CLASS}::before {
      content: "";
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, var(--ai-dim-opacity, 0.35));
      border-radius: 12px;
      pointer-events: none;
    }
    ${RESULT_SELECTOR} .ai-semantic-badge {
      display: inline-block;
  background: var(--ai-highlight-color, #00c896);
  color: #03100c;
      font-weight: 600;
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 12px;
      margin-right: 8px;
    }
  `;
  document.head.appendChild(style);
}

function scoreToColor(score) {
  if (score < 0.2) {
    return "#000000";
  }
  if (score < 0.5) {
    return "#6b7280"; // gray
  }
  if (score < 0.7) {
    return "#10b981"; // green
  }
  return "#22d3ee"; // teal for top matches
}

function dimOpacity(score) {
  if (score < 0.2) {
    return "0.55";
  }
  if (score < 0.5) {
    return "0.35";
  }
  return "0";
}

function passesFilters(entry) {
  if (!entry || typeof entry.score !== "number" || entry.score < config.minScore) {
    return false;
  }

  const imageScore = typeof entry.image_score === "number" ? entry.image_score : null;
  if (imageScore !== null && imageScore < imageThresholds.min && entry.score < 0.35) {
    return false;
  }

  if (!lastQueryTokens.length) {
    return true;
  }
  const title = (entry.title || "").toLowerCase();
  const description = (entry.description || "").toLowerCase();
  const hashtags = extractHashtags(`${title} ${description}`).join(" ");
  const combined = `${title} ${description} ${hashtags}`;

  // For ambiguous "apple" queries: block tech/brand, allow fruit or neutral content
  if (config.enableBrandFilter && lastQueryTokens.includes("apple")) {
    const hasFruit = APPLE_FRUIT_KEYWORDS.some((kw) => combined.includes(kw));
    const hasBrand = APPLE_BRAND_KEYWORDS.some((kw) => combined.includes(kw));
    if (hasBrand && !hasFruit) {
      return false; // tech/brand present without fruit context
    }
    // If not brand, allow even if fruit keywords missing; imageScore still respected above
  }
  const tokenPresent = lastQueryTokens.some((token) => combined.includes(token));
  if (!tokenPresent) {
    if (imageScore !== null && imageScore >= imageThresholds.strong) {
      return true;
    }
    return false;
  }
  
  // Backend already handles music filtering, flower/apple disambiguation, and feedback-based learning
  // Just check if blacklisted by user feedback
  if (isBlacklisted(entry.title || "", lastQueryTokens.join(" "))) {
    return false;
  }
  
  return true;
}

function extractHashtags(text) {
  if (!text) return [];
  return text
    .split(/\s+/u)
    .filter((token) => token.startsWith("#"))
    .map((tag) => tag.replace(/^#+/u, "").toLowerCase())
    .filter(Boolean);
}

function normalizeTitle(title = "") {
  return title.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function isBlacklisted(queryKey, title) {
  if (!queryKey || !title) return false;
  const titles = wrongBlacklist[queryKey];
  if (!titles || !titles.length) return false;
  return titles.includes(normalizeTitle(title));
}

async function loadBlacklist() {
  if (!chrome?.runtime?.id) {
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-blacklist" });
    if (response && !response.error) {
      wrongBlacklist = response;
      console.log("[AIS] Blacklist loaded:", Object.keys(wrongBlacklist).length, "queries");
    }
  } catch (error) {
    // Silently fail if context invalidated
  }
}

function tokenize(text) {
  if (!text) {
    return [];
  }
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

function reorderNodes(items) {
  if (!config.enableReorder) {
    console.log("[AIS] Reordering disabled");
    return;
  }
  if (!items.length) {
    return;
  }

  const container = items[0].node.parentElement;
  if (!container) {
    return;
  }

  const sorted = [...items].sort((a, b) => {
    const tierDiff = tierFor(b) - tierFor(a);
    if (tierDiff !== 0) {
      return tierDiff;
    }
    const scoreDiff = (b.score ?? -1) - (a.score ?? -1);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return a.index - b.index;
  });

  const newSignature = sorted.map((item) => item.node.getAttribute(ATTRIBUTE_ID) || "").join("|");
  if (newSignature === lastOrderSignature) {
    return;
  }

  lastOrderSignature = newSignature;
  
  console.log(`[AIS] REORDERING: Moving ${sorted.filter(s => s.passes).length} passing videos to top`);
  const topScores = sorted.slice(0, 5).map(s => ({
    title: s.entry?.title?.substring(0, 40) || "unknown",
    score: s.score?.toFixed(3) || "0",
    passes: s.passes
  }));
  console.log("[AIS] Top 5 after reorder:", topScores);

  sorted.forEach((item, index) => {
    const targetIndex = index;
    const currentNodeAtTarget = container.children[targetIndex];
    if (currentNodeAtTarget === item.node) {
      return;
    }
    container.insertBefore(item.node, currentNodeAtTarget || null);
  });
}

function tierFor(item) {
  if (!item.entry) {
    return 0;
  }
  if (!item.passes) {
    return 1;
  }
  const score = item.score || 0;
  const imageScore = typeof item.entry.image_score === "number" ? item.entry.image_score : null;
  if (imageScore !== null) {
    if (imageScore >= imageThresholds.top) {
      return 7;
    }
    if (imageScore >= imageThresholds.strong) {
      return 6;
    }
  }

  let baseTier = 1;
  if (score >= 0.01) {
    baseTier = 2;
  }
  if (score >= 0.2) {
    baseTier = 3;
  }
  if (score >= 0.5) {
    baseTier = 4;
  }
  if (score >= 0.8) {
    baseTier = 5;
  }
  return baseTier;
}

function getThumbnailUrl(node) {
  const img = node.querySelector("ytd-thumbnail img") || node.querySelector("img");
  if (!img) {
    return "";
  }
  const src = img.getAttribute("src") || "";
  if (src && !src.startsWith("data:")) {
    return src;
  }
  const srcSet = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
  if (srcSet) {
    const firstEntry = srcSet.split(",").map((entry) => entry.trim().split(" ")[0]).find(Boolean);
    if (firstEntry) {
      return firstEntry;
    }
  }
  const fallback = img.dataset?.thumb || img.dataset?.src;
  return fallback || "";
}

function scoreFormat(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function computeImageThresholds(mode) {
  switch (normalizeImageMode(mode)) {
    case "strict":
      return { min: 0.35, strong: 0.55, top: 0.75 };
    case "boosted":
      return { min: 0.18, strong: 0.4, top: 0.6 };
    default:
      return { min: 0.2, strong: 0.45, top: 0.65 };
  }
}

function normalizeImageMode(value) {
  return ["balanced", "boosted", "strict"].includes(value) ? value : DEFAULT_CONFIG.imageMode;
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}
