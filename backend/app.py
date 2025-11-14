from __future__ import annotations

import io
import logging
from collections import OrderedDict
from typing import Any, Dict, List, Optional

import requests
import torch
from flask import Flask, jsonify, request
from PIL import Image
from sentence_transformers import SentenceTransformer, util

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

MODEL_NAME = "all-MiniLM-L6-v2"
CLIP_MODEL_NAME = "clip-ViT-B-32"
TEXT_WEIGHT = 0.3
IMAGE_WEIGHT = 0.7
IMAGE_CACHE_MAX = 128

model = SentenceTransformer(MODEL_NAME)
clip_model = SentenceTransformer(CLIP_MODEL_NAME)


class ImageEmbeddingCache:
  def __init__(self, max_size: int) -> None:
    self._store: OrderedDict[str, Optional[torch.Tensor]] = OrderedDict()
    self._max_size = max_size

  def get(self, key: str) -> Optional[torch.Tensor]:
    if key in self._store:
      self._store.move_to_end(key)
      return self._store[key]
    return None

  def set(self, key: str, value: Optional[torch.Tensor]) -> None:
    self._store[key] = value
    self._store.move_to_end(key)
    if len(self._store) > self._max_size:
      self._store.popitem(last=False)


image_cache = ImageEmbeddingCache(IMAGE_CACHE_MAX)
http = requests.Session()


@app.after_request
def add_cors_headers(response: Any) -> Any:
  origin = request.headers.get("Origin", "*")
  response.headers["Access-Control-Allow-Origin"] = origin
  response.headers["Access-Control-Allow-Credentials"] = "true"
  response.headers["Access-Control-Allow-Headers"] = "Content-Type, Accept"
  response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
  response.headers.setdefault("Vary", "Origin")
  return response


@app.get("/health")
def health() -> Any:
  return jsonify({"status": "ok", "model": MODEL_NAME})


@app.route("/search", methods=["POST", "OPTIONS"])
def search() -> Any:
  if request.method == "OPTIONS":
    preflight = app.make_response(("", 204))
    return preflight
  payload = request.get_json(force=True, silent=True) or {}
  query = (payload.get("query") or "").strip()
  items: List[Dict[str, Any]] = payload.get("items") or []

  if not query or not items:
    response = jsonify({"error": "Missing query or items"})
    response.status_code = 400
    return response

  texts = []
  ids = []
  titles = []
  descriptions = []
  thumbnails = []
  for item in items:
    text = (item.get("text") or "").strip()
    if not text:
      continue
    texts.append(text)
    ids.append(item.get("id"))
    titles.append(item.get("title") or "")
    descriptions.append(item.get("description") or "")
    thumbnails.append(item.get("thumbnail") or "")

  if not texts:
    response = jsonify({"error": "No valid text items"})
    response.status_code = 400
    return response

  query_embedding = model.encode(query, convert_to_tensor=True, normalize_embeddings=True)
  item_embeddings = model.encode(texts, convert_to_tensor=True, normalize_embeddings=True)
  similarities = util.cos_sim(query_embedding, item_embeddings)[0].tolist()

  clip_query = clip_model.encode(
    [query],
    convert_to_tensor=True,
    normalize_embeddings=True,
    show_progress_bar=False,
  )[0]

  image_scores: List[Optional[float]] = []
  for thumbnail in thumbnails:
    image_scores.append(compute_image_score(thumbnail, clip_query))

  combined_scores: List[float] = []
  for text_score, image_score in zip(similarities, image_scores):
    if image_score is None:
      combined_scores.append(text_score)
    else:
      combined_scores.append((text_score * TEXT_WEIGHT) + (image_score * IMAGE_WEIGHT))

  ranked = sorted(
    (
      {
        "id": id_value,
        "score": combined,
        "title": title,
        "text": text,
        "description": description,
        "thumbnail": thumbnail,
        "image_score": image_score,
        "text_score": text_score,
      }
      for id_value, combined, title, text, description, thumbnail, image_score, text_score in zip(
        ids,
        combined_scores,
        titles,
        texts,
        descriptions,
        thumbnails,
        image_scores,
        similarities,
      )
    ),
    key=lambda row: row["score"],
    reverse=True,
  )

  response = jsonify({"ranked": ranked})
  return response


def compute_image_score(url: str, clip_query: torch.Tensor) -> Optional[float]:
  if not url:
    return None
  embedding = fetch_image_embedding(url)
  if embedding is None:
    return None
  with torch.no_grad():
    query_vec = clip_query.unsqueeze(0)
    score = util.cos_sim(query_vec, embedding.unsqueeze(0))[0][0].item()
  return normalize_clip_score(score)


def fetch_image_embedding(url: str) -> Optional[torch.Tensor]:
  cached = image_cache.get(url)
  if cached is not None:
    return cached

  try:
    response = http.get(url, timeout=5)
    response.raise_for_status()
    with Image.open(io.BytesIO(response.content)) as image:
      image_rgb = image.convert("RGB")
      with torch.no_grad():
        embedding = clip_model.encode(
          [image_rgb],
          convert_to_tensor=True,
          normalize_embeddings=True,
          show_progress_bar=False,
        )[0]
  except Exception as exc:  # pylint: disable=broad-except
    logging.warning("Failed to fetch thumbnail %s: %s", url, exc)
    image_cache.set(url, None)
    return None

  image_cache.set(url, embedding)
  return embedding


def normalize_clip_score(value: float) -> float:
  scaled = (value + 1.0) / 2.0
  if scaled < 0.0:
    return 0.0
  if scaled > 1.0:
    return 1.0
  return float(scaled)


if __name__ == "__main__":
  app.run(host="127.0.0.1", port=5000, debug=True)
