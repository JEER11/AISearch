# Implementation Plan

1. Build a Flask API (`backend/app.py`) that encodes queries and result texts with a SentenceTransformer model and responds with similarity scores.
2. Create a Chrome extension (`extension/`) that collects YouTube search results, requests scores from the backend, and annotates the page with AI match badges.
3. Provide a popup UI to toggle the feature and configure the backend endpoint for quick demos.
4. Document setup and demo instructions in `README.md` so teammates can reproduce the workflow.
