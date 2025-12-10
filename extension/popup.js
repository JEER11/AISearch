const DEFAULTS = {
  backendUrl: "http://127.0.0.1:5000/search",
  enabled: true,
  maxItems: 30,
  minScore: 0.25,
  imageMode: "balanced",
  enableReorder: true,
  showBadges: true,
  enableMusicFilter: true,
  enableBrandFilter: true,
  enableIntentBoost: true,
  enableTemporalBoost: true
};

const elements = {
  enabled: document.getElementById("enabled"),
  backendUrl: document.getElementById("backendUrl"),
  maxItems: document.getElementById("maxItems"),
  minScore: document.getElementById("minScore"),
  imageMode: document.getElementById("imageMode"),
  enableReorder: document.getElementById("enableReorder"),
  showBadges: document.getElementById("showBadges"),
  enableMusicFilter: document.getElementById("enableMusicFilter"),
  enableBrandFilter: document.getElementById("enableBrandFilter"),
  enableIntentBoost: document.getElementById("enableIntentBoost"),
  enableTemporalBoost: document.getElementById("enableTemporalBoost"),
  save: document.getElementById("save"),
  reset: document.getElementById("reset"),
  test: document.getElementById("test"),
  refreshStats: document.getElementById("refreshStats"),
  clearFeedback: document.getElementById("clearFeedback"),
  feedbackStats: document.getElementById("feedbackStats"),
  status: document.getElementById("status")
};

init();

function init() {
  elements.save.addEventListener("click", saveSettings);
  elements.reset.addEventListener("click", resetSettings);
  elements.test.addEventListener("click", testConnection);
  elements.refreshStats.addEventListener("click", loadFeedbackStats);
  elements.clearFeedback.addEventListener("click", clearFeedbackData);
  loadSettings().catch((error) => updateStatus(error.message, true));
  loadFeedbackStats();
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
  const enableMusicFilter = elements.enableMusicFilter.checked;
  const enableBrandFilter = elements.enableBrandFilter.checked;
  const enableIntentBoost = elements.enableIntentBoost.checked;
  const enableTemporalBoost = elements.enableTemporalBoost.checked;

  return { 
    backendUrl, 
    enabled, 
    maxItems, 
    minScore, 
    imageMode, 
    enableReorder, 
    showBadges,
    enableMusicFilter,
    enableBrandFilter,
    enableIntentBoost,
    enableTemporalBoost
  };
}

function applySettingsToUi(settings) {
  elements.enabled.checked = Boolean(settings.enabled);
  elements.backendUrl.value = settings.backendUrl || "";
  elements.maxItems.value = settings.maxItems ?? DEFAULTS.maxItems;
  elements.minScore.value = Math.round((settings.minScore ?? DEFAULTS.minScore) * 100);
  elements.imageMode.value = normalizeImageMode(settings.imageMode);
  elements.enableReorder.checked = Boolean(settings.enableReorder ?? DEFAULTS.enableReorder);
  elements.showBadges.checked = Boolean(settings.showBadges ?? DEFAULTS.showBadges);
  elements.enableMusicFilter.checked = Boolean(settings.enableMusicFilter ?? DEFAULTS.enableMusicFilter);
  elements.enableBrandFilter.checked = Boolean(settings.enableBrandFilter ?? DEFAULTS.enableBrandFilter);
  elements.enableIntentBoost.checked = Boolean(settings.enableIntentBoost ?? DEFAULTS.enableIntentBoost);
  elements.enableTemporalBoost.checked = Boolean(settings.enableTemporalBoost ?? DEFAULTS.enableTemporalBoost);
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

async function loadFeedbackStats() {
  elements.feedbackStats.innerHTML = '<p class="hint">Loading feedback data...</p>';
  
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-feedback-stats" });
    
    if (response?.error) {
      elements.feedbackStats.innerHTML = `<p class="hint" style="color: #f87171;">Error: ${response.error}</p>`;
      return;
    }
    
    const stats = response;
    const totalFeedback = stats.totalFeedback || 0;
    const helpful = stats.byFeedback?.helpful || 0;
    const wrong = stats.byFeedback?.wrong || 0;
    const clicked = stats.byFeedback?.clicked || 0;
    
    if (totalFeedback === 0) {
      elements.feedbackStats.innerHTML = '<p class="hint">No feedback data yet. Use 👍/👎 buttons on search results to provide feedback.</p>';
      return;
    }
    
    let html = '<div class="stats-grid">';
    html += `<div class="stat-box"><span class="stat-box__value">${totalFeedback}</span><span class="stat-box__label">Total</span></div>`;
    html += `<div class="stat-box"><span class="stat-box__value">${helpful}</span><span class="stat-box__label">Helpful</span></div>`;
    html += `<div class="stat-box"><span class="stat-box__value">${wrong}</span><span class="stat-box__label">Wrong</span></div>`;
    html += '</div>';
    
    // Show top queries with feedback
    if (stats.byQuery && Object.keys(stats.byQuery).length > 0) {
      html += '<div style="margin-top: 12px;"><strong>Top Queries:</strong>';
      const topQueries = Object.entries(stats.byQuery)
        .sort((a, b) => (b[1].helpful + b[1].wrong) - (a[1].helpful + a[1].wrong))
        .slice(0, 3);
      
      topQueries.forEach(([query, counts]) => {
        html += `<p style="margin: 4px 0; font-size: 11px;">• "${query}": ${counts.helpful}👍 ${counts.wrong}👎</p>`;
      });
      html += '</div>';
    }
    
    elements.feedbackStats.innerHTML = html;
  } catch (error) {
    elements.feedbackStats.innerHTML = `<p class="hint" style="color: #f87171;">Failed to load stats: ${error.message}</p>`;
  }
}

async function clearFeedbackData() {
  if (!confirm('Clear all feedback data? This cannot be undone.')) {
    return;
  }
  
  try {
    await chrome.storage.local.set({ search_feedback: [] });
    updateStatus('Feedback data cleared.');
    loadFeedbackStats();
  } catch (error) {
    updateStatus(`Failed to clear: ${error.message}`, true);
  }
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
