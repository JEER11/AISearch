# AI Social Search

A Chrome extension that uses AI to improve YouTube search results with two powerful modes:
- **Smart Reranker**: Automatically reorders search results based on semantic relevance
- **Tag Collector**: Finds and collects videos matching specific tags across hundreds of results

## Quick Start Guide

### Step 1: Install Python Backend

1. **Install Python** (if you don't have it):
   - Download Python 3.10 or newer from [python.org](https://www.python.org/downloads/)
   - During installation, check "Add Python to PATH"

2. **Open PowerShell** in the project folder:
   - Right-click the folder → "Open in Terminal" or "Open PowerShell window here"

3. **Create a virtual environment**:
   ```powershell
   python -m venv .venv
   ```

4. **Activate the virtual environment**:
   ```powershell
   .venv\Scripts\Activate.ps1
   ```

5. **Install dependencies**:
   ```powershell
   pip install -r backend/requirements.txt
   ```
   ⏱️ *This may take a few minutes. First run will download AI models (~500MB).*

6. **Start the backend**:
   ```powershell
   python backend/app.py
   ```
   ✅ You should see: `Running on http://127.0.0.1:5000`

   💡 **Keep this window open** while using the extension!

### Step 2: Install Chrome Extension

1. Open **Google Chrome** and go to: `chrome://extensions`

2. Toggle **Developer mode** ON (top-right corner)

3. Click **"Load unpacked"**

4. Select the `extension` folder from this project

5. ✅ You should see "AI Social Search" appear in your extensions

### Step 3: Use the Extension

**For Smart Reranker Mode:**
1. Go to YouTube and search for anything (e.g., "apple recipes")
2. Click the extension icon in your browser toolbar
3. Click **"Smart Reranker"** mode
4. Click **"Save"** to enable
5. Refresh the YouTube page
6. Results are now reordered by AI relevance with colored highlights!

**For Tag Collector Mode:**
1. Go to YouTube and search broadly (e.g., "art")
2. Click the extension icon
3. Click **"Tag Collector"** mode
4. Select tags or type custom ones (e.g., "watercolor, painting")
5. Add negative tags to exclude (e.g., "music, shorts")
6. Set min score (15-30 recommended) and max videos (50-100)
7. Click **"Start Collecting"**
8. The page will auto-scroll and collect matching videos
9. Copy links or create a playlist when done!

## Troubleshooting

**Backend won't start?**
- Make sure you activated the virtual environment (`.venv\Scripts\Activate.ps1`)
- Try: `pip install --upgrade pip` then reinstall requirements

**Extension not working?**
- Make sure the backend is running (check PowerShell window)
- In the extension popup, verify the URL is `http://127.0.0.1:5000/search`
- Check that "Enable semantic reranking" is ON

**No videos collected?**
- Lower the minimum score (try 15%)
- Make sure you're on a YouTube search results page
- Try broader search terms first

## Features

✨ **Smart Reranker**
- AI-powered semantic search reranking
- Visual thumbnail matching using CLIP
- Filters out irrelevant music/entertainment content
- Smart query intent detection (tutorials, reviews, factual content)
- Temporal boost for recent/trending videos

🎯 **Tag Collector**
- Auto-scroll through hundreds of YouTube results
- Match videos by semantic tags
- Exclude unwanted content with negative tags
- User feedback blocklist (thumbs down to never see again)
- Export to playlist or copy all links

## How It Works

The backend uses AI models (SentenceTransformers + CLIP) to understand the meaning of your search and video content, not just keywords. This means:
- Searching "apple recipes" shows cooking videos, not iPhone reviews
- Videos are ranked by actual relevance, not just view count
- Thumbnails are checked to match visual expectations

## Project Structure

```
├── backend/           # Python Flask API with AI models
│   ├── app.py        # Main backend server
│   └── requirements.txt
├── extension/         # Chrome extension
│   ├── manifest.json # Extension config
│   ├── background.js # Handles API calls
│   ├── content.js    # Modifies YouTube page
│   └── popup.html    # Extension settings UI
└── README.md
```
