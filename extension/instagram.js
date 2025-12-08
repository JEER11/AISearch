const RESULT_SELECTOR = "article";
const ATTRIBUTE_ID = "data-ai-semantic-id";
const HIGHLIGHT_CLASS = "ai-semantic-highlight";
const DEFAULT_CONFIG = {
  maxItems: 30,
  minScore: 0.01,
  enableReorder: true,
  showBadges: true,
  imageMode: "balanced"
};
const STORAGE_DEFAULTS = {
  enabled: true,
  backendUrl: "http://127.0.0.1:5000/search",
  maxItems: DEFAULT_CONFIG.maxItems,
  minScore: DEFAULT_CONFIG.minScore,
  enableReorder: DEFAULT_CONFIG.enableReorder,
  showBadges: DEFAULT_CONFIG.showBadges,
  imageMode: DEFAULT_CONFIG.imageMode
};

let lastQueryTokens = [];
let lastPayloadHash = "";
let observer = null;
let lastOrderSignature = "";
let settingsReady = false;
let config = { ...DEFAULT_CONFIG };
let imageThresholds = computeImageThresholds(config.imageMode);

init();

async function init() {
  injectStyles();
  observeResults();
  await loadSettings();
  chrome.storage.onChanged.addListener(handleStorageChanges);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  requestAnalysis();
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(STORAGE_DEFAULTS, (stored) => {
      applySettings(stored);
      settingsReady = true;
      resolve();
    });
  });
}

function handleStorageChanges(changes, area) {
  if (area !== "sync") {
    return;
  }
  const relevant = {};
  let hasChange = false;
  for (const key of ["maxItems", "minScore", "enableReorder", "showBadges", "imageMode"]) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      relevant[key] = changes[key].newValue;
      hasChange = true;
    }
  }
  if (!hasChange) {
    return;
  }
  applySettings(relevant);
  lastPayloadHash = "";
  requestAnalysis();
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
    imageMode: normalizeImageMode(candidate.imageMode)
  };
  imageThresholds = computeImageThresholds(config.imageMode);
}

function observeResults() {
  if (observer) {
    observer.disconnect();
  }
  observer = new MutationObserver(() => requestAnalysis());
  observer.observe(document.body, { childList: true, subtree: true });
}

function handleRuntimeMessage(message) {
  switch (message?.type) {
    case "semantic-results":
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

  const items = nodes
    .map((node, index) => {
      // Instagram post: extract text from captions and alt text
      const caption = node.querySelector("span a") || node.querySelector("[role='button']");
      const captionText = caption?.textContent?.trim() || "";
      const altText = node.querySelector("img")?.getAttribute("alt") || "";
      const description = `${captionText} ${altText}`.trim();
      
      const id = getOrAssignId(node, index);
      return {
        id,
        text: description || query,
        title: description.substring(0, 100),
        description: description,
        thumbnail: getThumbnailUrl(node)
      };
    })
    .filter((item) => item.text && item.text.length > 0);

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

  chrome.runtime.sendMessage({
    type: "semantic-score",
    payload
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
    node.insertAdjacentElement("afterbegin", badge);
  }
  badge.style.backgroundColor = color;
  const imageScore = typeof entry.image_score === "number" ? entry.image_score : null;
  if (imageScore !== null) {
    badge.textContent = `AI match: ${scoreFormat(score)} (img ${scoreFormat(entry.image_score)})`;
  } else {
    badge.textContent = `AI match: ${scoreFormat(score)}`;
  }
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
  return url.searchParams.get("q") || document.title.split(" • ")[0] || "";
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
      box-shadow: 0 0 0 2px rgba(255, 0, 127, 0.5) !important, 0 8px 20px rgba(0, 0, 0, 0.3);
      transition: outline 0.2s ease, box-shadow 0.2s ease;
    }
    ${RESULT_SELECTOR}.${HIGHLIGHT_CLASS}::before {
      content: "";
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, var(--ai-dim-opacity, 0.2));
      border-radius: 8px;
      pointer-events: none;
    }
    ${RESULT_SELECTOR} .ai-semantic-badge {
      display: inline-block;
      background: var(--ai-highlight-color, #ff007f);
      color: #ffffff;
      font-weight: 600;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 10px;
      margin: 4px;
      position: absolute;
      top: 8px;
      left: 8px;
      z-index: 100;
    }
  `;
  document.head.appendChild(style);
}

function scoreToColor(score) {
  if (score < 0.2) {
    return "#9ca3af";
  }
  if (score < 0.5) {
    return "#f97316"; // orange
  }
  if (score < 0.7) {
    return "#ec4899"; // pink
  }
  return "#ff007f"; // hot pink for top matches
}

function dimOpacity(score) {
  if (score < 0.2) {
    return "0.3";
  }
  if (score < 0.5) {
    return "0.15";
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
  const combined = `${title} ${description}`;
  const tokenPresent = lastQueryTokens.some((token) => combined.includes(token));
  if (!tokenPresent) {
    if (imageScore !== null && imageScore >= imageThresholds.strong) {
      return true;
    }
    return false;
  }
  return true;
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
  const img = node.querySelector("img");
  if (!img) {
    return "";
  }
  const src = img.getAttribute("src") || "";
  if (src && !src.startsWith("data:")) {
    return src;
  }
  return "";
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
