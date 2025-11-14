# AI Social Search Demo

This project demonstrates how a Chrome extension can call a local Flask API that performs semantic reranking on YouTube search results using sentence-transformer embeddings.

## Project layout

- `extension/` – Chrome extension assets (`manifest.json`, background service worker, content script, popup UI).
- `backend/` – Flask service that wraps a SentenceTransformer model to score results.

## Prerequisites

- Python 3.10+
- Google Chrome (or Chromium-based browser)

## Backend setup

1. Create and activate a virtual environment.
2. Install dependencies:
   ```powershell
   pip install -r backend/requirements.txt
   ```
3. Start the Flask API:
   ```powershell
   python backend/app.py
   ```
4. Wait for the console log indicating the server is running on `http://127.0.0.1:5000`.

## Extension setup

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Choose **Load unpacked** and select the `extension` directory from this project.
3. Click the extension icon to open the popup. Ensure the backend URL is `http://127.0.0.1:5000/search` and the toggle is enabled.
4. Visit a YouTube search results page, e.g., `https://www.youtube.com/results?search_query=funny+puppy+videos`.
5. The extension highlights search results and adds an "AI match" badge that reflects semantic similarity scores returned by the backend.

## Notes

- The demo currently targets YouTube result pages. You can extend the selectors in `extension/content.js` to support other platforms.
- The backend normalizes embeddings to provide cosine similarities between 0 and 1. Scores are displayed as percentages for readability.
- Image relevance uses CLIP embeddings fetched from YouTube thumbnails; ensure `requests` and `Pillow` are installed (included in `requirements.txt`).
- Running SentenceTransformer models may require downloading model weights on first launch; allow a few minutes for the initial load and cache.
