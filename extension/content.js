const RESULT_SELECTOR = "ytd-video-renderer";
const ATTRIBUTE_ID = "data-ai-semantic-id";
const HIGHLIGHT_CLASS = "ai-semantic-highlight";
const MAX_ITEMS = 30;
const MIN_SCORE = 0.01;
const IMAGE_MIN = 0.2;
const IMAGE_STRONG = 0.45;
const IMAGE_TOP = 0.65;
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

let lastQueryTokens = [];
let lastPayloadHash = "";
let observer = null;
let lastOrderSignature = "";

init();

function init() {
  injectStyles();
  observeResults();
  requestAnalysis();
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
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
  const nodes = Array.from(document.querySelectorAll(RESULT_SELECTOR)).slice(0, MAX_ITEMS);
  const query = getQuery();
  if (!query || !nodes.length) {
    return null;
  }

  const items = nodes
    .map((node, index) => {
      const title = node.querySelector("#video-title")?.textContent?.trim() || "";
      const description = node.querySelector("#description-text")?.textContent?.trim() || "";
      const id = getOrAssignId(node, index);
      return {
        id,
        text: `${title}\n${description}`.trim(),
        title,
        description,
        thumbnail: getThumbnailUrl(node)
      };
    })
    .filter((item) => item.text.length > 0);

  if (!items.length) {
    return null;
  }

  return { query, items };
}

function requestAnalysis() {
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
  if (score < MIN_SCORE) {
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
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "ai-semantic-badge";
    const titleContainer = node.querySelector("#video-title" );
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
  if (!entry || typeof entry.score !== "number" || entry.score < MIN_SCORE) {
    return false;
  }

  const imageScore = typeof entry.image_score === "number" ? entry.image_score : null;
  if (imageScore !== null && imageScore < IMAGE_MIN && entry.score < 0.35) {
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
    if (imageScore !== null && imageScore >= IMAGE_STRONG) {
      return true;
    }
    return false;
  }
  const negativeFound = NEGATIVE_KEYWORDS.some((keyword) => title.includes(keyword) || description.includes(keyword));
  const tokenInDescription = lastQueryTokens.some((token) => description.includes(token));
  if (negativeFound && !tokenInDescription) {
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
    if (imageScore >= IMAGE_TOP) {
      return 7;
    }
    if (imageScore >= IMAGE_STRONG) {
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
