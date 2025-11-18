const DEFAULT_BACKEND_URL = "http://127.0.0.1:5000/search";
const DEFAULT_SETTINGS = {
  backendUrl: DEFAULT_BACKEND_URL,
  enabled: true,
  maxItems: 30,
  minScore: 0.01,
  enableReorder: true,
  showBadges: true,
  imageMode: "balanced"
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function handleSemanticRequest(message, sender) {
  const { query, items } = message.payload || {};
  if (!query || !Array.isArray(items) || !items.length || !sender.tab?.id) {
    return;
  }

  const { backendUrl, enabled } = await getSettings();
  if (!enabled) {
    await chrome.tabs.sendMessage(sender.tab.id, { type: "semantic-disabled" });
    return;
  }

  try {
    const response = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, items })
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
      data
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
    default:
      return undefined;
  }
});
