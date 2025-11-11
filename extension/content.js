const RESULT_SELECTOR = "ytd-video-renderer";
const ATTRIBUTE_ID = "data-ai-semantic-id";
const HIGHLIGHT_CLASS = "ai-semantic-highlight";
const MAX_ITEMS = 30;

let lastPayloadHash = "";
let observer = null;

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

  const items = nodes.map((node, index) => {
    const title = node.querySelector("#video-title")?.textContent?.trim() || "";
    const description = node.querySelector("#description-text")?.textContent?.trim() || "";
    const id = getOrAssignId(node, index);
    return { id, text: `${title}\n${description}`.trim(), title };
  }).filter((item) => item.text.length > 0);

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

  const hash = JSON.stringify({ query: payload.query, ids: payload.items.map((item) => item.id) });
  if (hash === lastPayloadHash) {
    return;
  }
  lastPayloadHash = hash;

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

  const scores = new Map(data.ranked.map((item) => [item.id, item.score]));
  const nodes = document.querySelectorAll(`${RESULT_SELECTOR}[${ATTRIBUTE_ID}]`);

  nodes.forEach((node) => {
    const id = node.getAttribute(ATTRIBUTE_ID);
    const score = scores.get(id);
    if (typeof score === "number") {
      highlightNode(node, score);
    } else {
      resetNode(node);
    }
  });
}

function highlightNode(node, score) {
  node.classList.add(HIGHLIGHT_CLASS);
  node.style.setProperty("--ai-semantic-score", score.toFixed(3));
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
  badge.textContent = `AI match: ${(score * 100).toFixed(1)}%`;
}

function resetNode(node) {
  node.classList.remove(HIGHLIGHT_CLASS);
  node.style.removeProperty("--ai-semantic-score");
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
      outline: 2px solid #00c896;
      position: relative;
    }
    ${RESULT_SELECTOR} .ai-semantic-badge {
      display: inline-block;
      background: #00c896;
      color: #0b1f17;
      font-weight: 600;
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 12px;
      margin-right: 8px;
    }
  `;
  document.head.appendChild(style);
}
