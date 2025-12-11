const DEFAULT_BACKEND_URL = "http://127.0.0.1:5000/search";
const DEFAULT_SETTINGS = {
  backendUrl: DEFAULT_BACKEND_URL,
  enabled: true,
  maxItems: 100,  // Analyze many more videos to find good content further down
  minScore: 0.0,  // Show everything - let user see what gets scored
  enableReorder: true,
  showBadges: true,
  imageMode: "balanced",
  enableMusicFilter: true,
  enableBrandFilter: true,
  enableIntentBoost: true,
  enableTemporalBoost: true
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function handleSemanticRequest(message, sender) {
  const { query, items } = message.payload || {};
  const { hash } = message;
  if (!query || !Array.isArray(items) || !items.length || !sender.tab?.id) {
    return;
  }

  const { backendUrl, enabled } = await getSettings();
  if (!enabled) {
    await chrome.tabs.sendMessage(sender.tab.id, { type: "semantic-disabled" });
    return;
  }

  try {
    // Include feedback history for similarity-based learning
    const feedbackHistory = await getFeedbackHistory();
    
    const response = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, items, feedback: feedbackHistory })
    });

    if (!response.ok) {
      const text = await response.text();
      await chrome.tabs.sendMessage(sender.tab.id, {
        type: "semantic-error",
        error: `Backend error: ${response.status} ${text}`
      });
      return;
    }

    const data = await response.json();
    await chrome.tabs.sendMessage(sender.tab.id, {
      type: "semantic-results",
      data,
      hash
    });
  } catch (error) {
    await chrome.tabs.sendMessage(sender.tab.id, {
      type: "semantic-error",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case "semantic-score":
      handleSemanticRequest(message, sender);
      return true;
    case "get-settings":
      getSettings().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
      return true;
    case "set-settings":
      chrome.storage.sync.set(message.payload || {}).then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ error: error.message }));
      return true;
    case "log-feedback":
      logSearchFeedback(message.payload);
      sendResponse({ ok: true });
      return true;
    case "get-feedback-stats":
      getSearchFeedbackStats().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
      return true;
    case "get-blacklist":
      getWrongBlacklist().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
      return true;
    case "get-feedback":
      getFeedbackHistory().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
      return true;
    default:
      return undefined;
  }
});

/**
 * Log user feedback about search results (thumbs up/down, click tracking)
 */
async function logSearchFeedback(payload) {
  const { query, resultId, feedback, title } = payload;
  if (!query || !resultId || !feedback) {
    return;
  }

  const feedbackKey = "search_feedback";
  const stored = await chrome.storage.local.get(feedbackKey);
  const feedbackLog = stored[feedbackKey] || [];

  feedbackLog.push({
    query,
    resultId,
    title,
    feedback, // "helpful", "wrong", "clicked"
    timestamp: Date.now()
  });

  // Keep last 500 feedback entries to avoid storage bloat
  const trimmed = feedbackLog.slice(-500);
  await chrome.storage.local.set({ [feedbackKey]: trimmed });
}

/**
 * Get feedback statistics to detect patterns (e.g., which queries need better filtering)
 */
async function getSearchFeedbackStats() {
  const feedbackKey = "search_feedback";
  const stored = await chrome.storage.local.get(feedbackKey);
  const feedbackLog = stored[feedbackKey] || [];

  const stats = {
    totalFeedback: feedbackLog.length,
    byFeedback: { helpful: 0, wrong: 0, clicked: 0 },
    byQuery: {},
    wrongQueries: []
  };

  feedbackLog.forEach((entry) => {
    stats.byFeedback[entry.feedback] = (stats.byFeedback[entry.feedback] || 0) + 1;
    if (!stats.byQuery[entry.query]) {
      stats.byQuery[entry.query] = { helpful: 0, wrong: 0, clicked: 0 };
    }
    stats.byQuery[entry.query][entry.feedback]++;
    if (entry.feedback === "wrong") {
      stats.wrongQueries.push({ query: entry.query, title: entry.title });
    }
  });

  return stats;
}

/**
 * Build a blacklist of titles the user marked as wrong, grouped by query.
 * Content scripts use this to hide items the user rejected from future rankings.
 */
async function getWrongBlacklist() {
  const feedbackKey = "search_feedback";
  const stored = await chrome.storage.local.get(feedbackKey);
  const feedbackLog = stored[feedbackKey] || [];

  const blacklist = {};
  for (const entry of feedbackLog) {
    if (entry.feedback !== "wrong" || !entry.title) continue;
    const q = (entry.query || "").toLowerCase();
    if (!q) continue;
    if (!blacklist[q]) blacklist[q] = new Set();
    blacklist[q].add(normalizeTitle(entry.title));
  }

  const serialized = {};
  for (const [query, titles] of Object.entries(blacklist)) {
    serialized[query] = Array.from(titles);
  }
  return serialized;
}

function normalizeTitle(title = "") {
  return title.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

/**
 * Get positive/negative feedback history for similarity-based learning
 */
async function getFeedbackHistory() {
  const feedbackKey = "search_feedback";
  const stored = await chrome.storage.local.get(feedbackKey);
  const feedbackLog = stored[feedbackKey] || [];
  
  const positive = [];
  const negative = [];
  
  for (const entry of feedbackLog) {
    const item = {
      title: entry.title || "",
      description: entry.description || "",
      query: entry.query || ""
    };
    
    if (entry.feedback === "helpful" || entry.feedback === "right") {
      positive.push(item);
    } else if (entry.feedback === "wrong") {
      negative.push(item);
    }
  }
  
  return { positive, negative };
}

/**
 * Train backend classifier with accumulated feedback (call periodically)
 */
async function trainNegativeClassifier() {
  const feedbackKey = "search_feedback";
  const stored = await chrome.storage.local.get(feedbackKey);
  const feedbackLog = stored[feedbackKey] || [];
  
  if (feedbackLog.length < 10) {
    console.log("Not enough feedback to train classifier yet");
    return;
  }
  
  // Convert feedback log to format backend expects
  const feedbackData = feedbackLog
    .filter(entry => entry.feedback === "helpful" || entry.feedback === "wrong")
    .map(entry => ({
      title: entry.title || "",
      description: "",  // We don't store descriptions in feedback log
      feedback: entry.feedback === "helpful" ? "up" : "down"
    }));
  
  if (feedbackData.length < 10) {
    console.log("Not enough helpful/wrong feedback to train");
    return;
  }
  
  try {
    const response = await fetch("http://127.0.0.1:5000/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback_data: feedbackData })
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log(`Trained negative classifier on ${result.samples} samples. Learned keywords:`, result.learned_keywords);
    }
  } catch (error) {
    console.warn("Failed to train negative classifier:", error);
  }
}

// Train classifier every 20 feedback entries
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.search_feedback) {
    const newLog = changes.search_feedback.newValue || [];
    if (newLog.length > 0 && newLog.length % 20 === 0) {
      trainNegativeClassifier();
    }
  }
});

