const elements = {
  enabled: document.getElementById("enabled"),
  backendUrl: document.getElementById("backendUrl"),
  save: document.getElementById("save"),
  status: document.getElementById("status")
};

init();

function init() {
  elements.save.addEventListener("click", saveSettings);
  loadSettings().catch((error) => updateStatus(error.message, true));
}

async function loadSettings() {
  updateStatus("Loading settings...");
  const response = await chrome.runtime.sendMessage({ type: "get-settings" });
  if (response?.error) {
    throw new Error(response.error);
  }

  elements.enabled.checked = Boolean(response.enabled);
  elements.backendUrl.value = response.backendUrl || "";
  updateStatus("Settings loaded.");
}

async function saveSettings() {
  elements.save.disabled = true;
  updateStatus("Saving...");
  const backendUrl = elements.backendUrl.value.trim() || undefined;
  const enabled = elements.enabled.checked;

  const response = await chrome.runtime.sendMessage({
    type: "set-settings",
    payload: { backendUrl, enabled }
  });

  if (response?.error) {
    updateStatus(response.error, true);
  } else {
    updateStatus("Saved.");
  }

  elements.save.disabled = false;
}

function updateStatus(text, isError = false) {
  elements.status.textContent = text;
  elements.status.style.color = isError ? "#f87171" : "#9ca3af";
}
