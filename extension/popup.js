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
  enableTemporalBoost: true,
  // Collector mode defaults
  collectorMinScore: 25,
  collectorMaxVideos: 50
};

// UI Mode State
let currentMode = 'collector'; // 'collector' or 'reranker'
let selectedTags = new Set();
let collectedVideos = [];
let isCollecting = false;

const elements = {
  // Mode buttons
  modeCollector: document.getElementById("modeCollector"),
  modeReranker: document.getElementById("modeReranker"),
  collectorPanel: document.getElementById("collectorPanel"),
  rerankerPanel: document.getElementById("rerankerPanel"),
  
  // Collector elements
  tagChips: document.querySelectorAll(".tag-chip"),
  customTags: document.getElementById("customTags"),
  collectorMinScore: document.getElementById("collectorMinScore"),
  collectorMaxVideos: document.getElementById("collectorMaxVideos"),
  startCollection: document.getElementById("startCollection"),
  stopCollection: document.getElementById("stopCollection"),
  collectionProgress: document.getElementById("collectionProgress"),
  progressFill: document.getElementById("progressFill"),
  progressStatus: document.getElementById("progressStatus"),
  progressCount: document.getElementById("progressCount"),
  resultsSection: document.getElementById("resultsSection"),
  videoResults: document.getElementById("videoResults"),
  copyLinks: document.getElementById("copyLinks"),
  createPlaylist: document.getElementById("createPlaylist"),
  clearResults: document.getElementById("clearResults"),
  
  // Reranker elements
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
  // Mode switchers
  elements.modeCollector.addEventListener("click", () => switchMode('collector'));
  elements.modeReranker.addEventListener("click", () => switchMode('reranker'));
  
  // Tag selection
  elements.tagChips.forEach(chip => {
    chip.addEventListener("click", () => toggleTag(chip));
  });
  
  // Collector controls
  elements.startCollection.addEventListener("click", startCollection);
  elements.stopCollection.addEventListener("click", stopCollection);
  elements.copyLinks.addEventListener("click", copyAllLinks);
  elements.createPlaylist.addEventListener("click", createPlaylist);
  elements.clearResults.addEventListener("click", clearResults);
  
  // Reranker controls
  elements.save.addEventListener("click", saveSettings);
  elements.reset.addEventListener("click", resetSettings);
  elements.test.addEventListener("click", testConnection);
  elements.refreshStats.addEventListener("click", loadFeedbackStats);
  elements.clearFeedback.addEventListener("click", clearFeedbackData);
  
  loadSettings().catch((error) => updateStatus(error.message, true));
  loadFeedbackStats();
}

function switchMode(mode) {
  currentMode = mode;
  
  if (mode === 'collector') {
    elements.modeCollector.classList.add('active');
    elements.modeReranker.classList.remove('active');
    elements.collectorPanel.style.display = 'block';
    elements.rerankerPanel.style.display = 'none';
  } else {
    elements.modeReranker.classList.add('active');
    elements.modeCollector.classList.remove('active');
    elements.rerankerPanel.style.display = 'block';
    elements.collectorPanel.style.display = 'none';
  }
}

function toggleTag(chip) {
  const tag = chip.dataset.tag;
  
  if (selectedTags.has(tag)) {
    selectedTags.delete(tag);
    chip.classList.remove('selected');
  } else {
    selectedTags.add(tag);
    chip.classList.add('selected');
  }
}

async function startCollection() {
  // Get all tags (predefined + custom)
  const tags = Array.from(selectedTags);
  const customTagsInput = elements.customTags.value.trim();
  if (customTagsInput) {
    const customTagsList = customTagsInput.split(',').map(t => t.trim()).filter(t => t);
    tags.push(...customTagsList);
  }
  
  if (tags.length === 0) {
    updateStatus('Please select or enter at least one tag', true);
    return;
  }
  
  const minScore = parseInt(elements.collectorMinScore.value);
  const maxVideos = parseInt(elements.collectorMaxVideos.value);
  
  isCollecting = true;
  collectedVideos = [];
  
  // Update UI
  elements.startCollection.style.display = 'none';
  elements.stopCollection.style.display = 'block';
  elements.collectionProgress.style.display = 'block';
  elements.resultsSection.style.display = 'none';
  elements.videoResults.innerHTML = '';
  
  updateProgress(0, maxVideos, 'Starting collection...');
  
  // Send message to active tab to start collecting
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!tab || !tab.url.includes('youtube.com')) {
    updateStatus('Please open a YouTube search results page', true);
    stopCollection();
    return;
  }
  
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'start-collection',
      tags: tags,
      minScore: minScore,
      maxVideos: maxVideos,
      backendUrl: elements.backendUrl.value
    });
  } catch (error) {
    updateStatus('Error: ' + error.message, true);
    stopCollection();
  }
}

function stopCollection() {
  isCollecting = false;
  elements.startCollection.style.display = 'block';
  elements.stopCollection.style.display = 'none';
  elements.collectionProgress.style.display = 'none';
  
  // Notify content script to stop
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'stop-collection' }).catch(() => {});
    }
  });
}

function updateProgress(current, max, status) {
  const percentage = (current / max) * 100;
  elements.progressFill.style.width = percentage + '%';
  elements.progressStatus.textContent = status;
  elements.progressCount.textContent = `${current} / ${max} videos found`;
}

function displayCollectedVideos() {
  if (collectedVideos.length === 0) {
    updateStatus('No videos matched your tags', true);
    return;
  }
  
  elements.resultsSection.style.display = 'block';
  elements.videoResults.innerHTML = '';
  
  collectedVideos.forEach(video => {
    const videoItem = document.createElement('div');
    videoItem.className = 'video-item';
    
    const matchingTags = video.matchedTags.join(', ');
    
    videoItem.innerHTML = `
      <img src="${video.thumbnail}" alt="${video.title}" class="video-thumb" />
      <div class="video-info">
        <h3 class="video-title">${video.title}</h3>
        <div class="video-score">Match: ${video.score}%</div>
        <div class="video-tags">Tags: ${matchingTags}</div>
      </div>
    `;
    
    videoItem.addEventListener('click', () => {
      window.open(video.url, '_blank');
    });
    
    elements.videoResults.appendChild(videoItem);
  });
  
  updateStatus(`Found ${collectedVideos.length} matching videos!`);
}

function copyAllLinks() {
  const links = collectedVideos.map(v => v.url).join('\n');
  navigator.clipboard.writeText(links).then(() => {
    updateStatus('All links copied to clipboard!');
  });
}

function createPlaylist() {
  // Generate YouTube playlist creation URL with all video IDs
  const videoIds = collectedVideos.map(v => {
    const match = v.url.match(/[?&]v=([^&]+)/);
    return match ? match[1] : null;
  }).filter(id => id);
  
  if (videoIds.length === 0) {
    updateStatus('No valid video IDs found', true);
    return;
  }
  
  // YouTube doesn't have a direct "create playlist" URL, so we'll copy the IDs
  const playlistText = `YouTube Video IDs (paste these into a new playlist):\n\n${videoIds.join('\n')}`;
  navigator.clipboard.writeText(playlistText).then(() => {
    updateStatus('Video IDs copied! Create a playlist and add these videos.');
    window.open('https://www.youtube.com/playlist?list=WL', '_blank'); // Opens "Watch Later" as example
  });
}

function clearResults() {
  collectedVideos = [];
  elements.videoResults.innerHTML = '';
  elements.resultsSection.style.display = 'none';
  updateStatus('Results cleared');
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'collection-progress') {
    updateProgress(message.current, message.max, message.status);
    collectedVideos = message.videos || collectedVideos;
  } else if (message.type === 'collection-complete') {
    collectedVideos = message.videos;
    stopCollection();
    displayCollectedVideos();
  } else if (message.type === 'collection-error') {
    updateStatus('Collection error: ' + message.error, true);
    stopCollection();
  }
});

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
