const DEFAULTS = {
  backendUrl: "http://127.0.0.1:5000/search",
  enabled: true,
  maxItems: 30,
  minScore: 0.01,
  imageMode: "balanced",
  enableReorder: true,
  showBadges: true
};

const elements = {
  enabled: document.getElementById("enabled"),
  backendUrl: document.getElementById("backendUrl"),
  maxItems: document.getElementById("maxItems"),
  minScore: document.getElementById("minScore"),
  imageMode: document.getElementById("imageMode"),
  enableReorder: document.getElementById("enableReorder"),
  showBadges: document.getElementById("showBadges"),
  save: document.getElementById("save"),
  reset: document.getElementById("reset"),
  test: document.getElementById("test"),
  status: document.getElementById("status")
};

init();

function init() {
  elements.save.addEventListener("click", saveSettings);
  elements.reset.addEventListener("click", resetSettings);
  elements.test.addEventListener("click", testConnection);
  loadSettings().catch((error) => updateStatus(error.message, true));
}

async function loadSettings() {
  updateStatus("Loading settings...");
  const response = await chrome.runtime.sendMessage({ type: "get-settings" });
  if (response?.error) {
    throw new Error(response.error);
  }
  applySettingsToUi({ ...DEFAULTS, ...response });
  updateStatus("Settings loaded.");
}

async function saveSettings() {
  elements.save.disabled = true;
  updateStatus("Saving...");

  const payload = collectPayload();
  const response = await chrome.runtime.sendMessage({
    type: "set-settings",
    payload
  });

  if (response?.error) {
    updateStatus(response.error, true);
  } else {
    updateStatus("Saved.");
  }

  elements.save.disabled = false;
}

function collectPayload() {
  const backendUrl = elements.backendUrl.value.trim() || undefined;
  const enabled = elements.enabled.checked;
  const maxItems = clamp(Number(elements.maxItems.value), 5, 50, DEFAULTS.maxItems);
  const minScorePercent = clamp(Number(elements.minScore.value), 0, 100, DEFAULTS.minScore * 100);
  const minScore = minScorePercent / 100;
  const imageMode = normalizeImageMode(elements.imageMode.value);
  const enableReorder = elements.enableReorder.checked;
  const showBadges = elements.showBadges.checked;

  return { backendUrl, enabled, maxItems, minScore, imageMode, enableReorder, showBadges };
}

function applySettingsToUi(settings) {
  elements.enabled.checked = Boolean(settings.enabled);
  elements.backendUrl.value = settings.backendUrl || "";
  elements.maxItems.value = settings.maxItems ?? DEFAULTS.maxItems;
  elements.minScore.value = Math.round((settings.minScore ?? DEFAULTS.minScore) * 100);
  elements.imageMode.value = normalizeImageMode(settings.imageMode);
  elements.enableReorder.checked = Boolean(settings.enableReorder ?? DEFAULTS.enableReorder);
  elements.showBadges.checked = Boolean(settings.showBadges ?? DEFAULTS.showBadges);
}

function resetSettings() {
  applySettingsToUi(DEFAULTS);
  saveSettings().catch((error) => updateStatus(error.message, true));
}

async function testConnection() {
  const url = (elements.backendUrl.value.trim() || DEFAULTS.backendUrl).replace(/\/?$/u, "");
  const healthUrl = url.endsWith("/search") ? `${url.slice(0, -7)}/health` : `${url}/health`;

  updateStatus("Testing connection...");
  elements.test.disabled = true;
  try {
    const response = await fetch(healthUrl, { method: "GET" });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const body = await response.json();
    updateStatus(`Healthy: ${body.model || "model ready"}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateStatus(`Connection failed: ${message}`, true);
  } finally {
    elements.test.disabled = false;
  }
}

function updateStatus(text, isError = false) {
  elements.status.textContent = text;
  elements.status.style.color = isError ? "#f87171" : "#9ca3af";
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

function normalizeImageMode(value) {
  const valid = ["balanced", "boosted", "strict"];
  return valid.includes(value) ? value : DEFAULTS.imageMode;
}
