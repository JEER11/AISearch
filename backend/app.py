from __future__ import annotations

import logging
from typing import List, Dict, Any

from flask import Flask, jsonify, request
from sentence_transformers import SentenceTransformer, util

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

MODEL_NAME = "all-MiniLM-L6-v2"
model = SentenceTransformer(MODEL_NAME)


@app.get("/health")
def health() -> Any:
  return jsonify({"status": "ok", "model": MODEL_NAME})


@app.post("/search")
def search() -> Any:
  payload = request.get_json(force=True, silent=True) or {}
  query = (payload.get("query") or "").strip()
  items: List[Dict[str, Any]] = payload.get("items") or []

  if not query or not items:
    response = jsonify({"error": "Missing query or items"})
    response.status_code = 400
    response.headers.add("Access-Control-Allow-Origin", "*")
    return response

  texts = []
  ids = []
  titles = []
  for item in items:
    text = (item.get("text") or "").strip()
    if not text:
      continue
    texts.append(text)
    ids.append(item.get("id"))
    titles.append(item.get("title") or "")

  if not texts:
    response = jsonify({"error": "No valid text items"})
    response.status_code = 400
    response.headers.add("Access-Control-Allow-Origin", "*")
    return response

  query_embedding = model.encode(query, convert_to_tensor=True, normalize_embeddings=True)
  item_embeddings = model.encode(texts, convert_to_tensor=True, normalize_embeddings=True)
  similarities = util.cos_sim(query_embedding, item_embeddings)[0].tolist()

  ranked = sorted(
    (
      {
        "id": id_value,
        "score": score,
        "title": title,
        "text": text,
      }
      for id_value, score, title, text in zip(ids, similarities, titles, texts)
    ),
    key=lambda row: row["score"],
    reverse=True,
  )

  response = jsonify({"ranked": ranked})
  response.headers.add("Access-Control-Allow-Origin", "*")
  return response


if __name__ == "__main__":
  app.run(host="127.0.0.1", port=5000, debug=True)
