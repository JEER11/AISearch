from __future__ import annotations

import io
import logging
from collections import OrderedDict
from typing import Any, Dict, List, Optional

import requests
from flask import Flask, jsonify, request
from PIL import Image

import os

# Use a lightweight pure-Python scorer by default so the backend starts
# quickly for local extension testing. Set environment variable
# `AIS_ENABLE_ML=1` to attempt loading heavy ML libraries instead.
USE_FALLBACK = os.environ.get("AIS_ENABLE_ML", "0") != "1"
SentenceTransformer = None
util = None
torch = None
if not USE_FALLBACK:
  try:
    import torch
    from sentence_transformers import SentenceTransformer, util
  except Exception as exc:  # pragma: no cover - runtime fallback
    USE_FALLBACK = True
    SentenceTransformer = None
    util = None
    torch = None
    logging.warning("ML imports failed, using fallback text scorer: %s", exc)

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

# all-mpnet-base-v2 provides superior semantic understanding with deeper contextual
# meaning compared to MiniLM. It's slower but much more accurate for NLU tasks.
MODEL_NAME = "all-mpnet-base-v2"
CLIP_MODEL_NAME = "clip-ViT-B-32"
# Prioritize text semantic understanding (60%) over image (40%) for better accuracy
TEXT_WEIGHT = float(os.environ.get("AIS_TEXT_WEIGHT", "0.6"))
IMAGE_WEIGHT = float(os.environ.get("AIS_IMAGE_WEIGHT", "0.4"))
IMAGE_CACHE_MAX = 128

# Semantic disambiguation: map queries to brand/company keywords (penalize) and fruit/natural keywords (boost)
BRAND_KEYWORDS = {
  "apple": [
    "iphone", "ipad", "macbook", "mac", "ios", "macos", "app store", "tim cook",
    "steve jobs", "cupertino", "wozniak", "event", "keynote", "airpods", "watch",
    "airplay", "siri", "icloud", "battery", "charge", "upgrade", "itunes", "safari",
    "facetime", "imessage", "apple tv", "airtag", "homepod"
  ],
  "orange": [
    "orange county", "orange is the new black", "theory"
  ],
  "cherry": [
    "cherry picking"
  ]
}

FRUIT_KEYWORDS = {
  "apple": [
    "fruit", "orchard", "tree", "picking", "harvest", "recipe", "cooking", "baking",
    "pie", "juice", "cider", "farmer", "garden", "organic", "crisp", "sweet",
    "health", "nutrition", "vitamin", "fresh", "farm", "grow", "seed", "core",
    "peel", "slice", "eat", "snack", "fuji", "granny smith", "gala", "honeycrisp"
  ],
  "orange": [
    "fruit", "citrus", "tree", "orchard", "vitamin c", "juice", "peel",
    "zest", "sweet", "taste", "recipe", "health", "fresh", "segment"
  ],
  "cherry": [
    "fruit", "tree", "orchard", "picking", "recipe", "pie", "sweet", "tart", "fresh"
  ]
}

# Universal music/entertainment keywords to filter out
MUSIC_KEYWORDS = [
  "lyrics", "official video", "music video", "audio", "song", "remix", "cover",
  "vevo", "karaoke", "live performance", "concert", "acoustic", "instrumental",
  "mv", "official mv", "topic", "feat", "ft.", "album", "single", "track",
  "playlist", "spotify", "apple music"
]

# Flower-related keywords for "flowers" query
FLOWER_KEYWORDS = {
  "flowers": [
    "garden", "bouquet", "bloom", "blossom", "petal", "plant", "growing",
    "florist", "arrangement", "wildflower", "rose", "tulip", "daisy", "lily",
    "sunflower", "orchid", "care", "planting", "gardening", "seeds", "soil",
    "water", "nature", "floral", "botanical"
  ]
}

# If the heavy models loaded successfully, instantiate them. Otherwise
# keep None and the code will use a simple fallback scorer.
model = None
clip_model = None
if not USE_FALLBACK:
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

  # Compute text similarities. Use the sentence-transformers model when
  # available, otherwise fall back to a lightweight token-overlap scorer.
  if model is not None and util is not None and torch is not None:
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
  else:
    # Fallback: simple token-overlap similarity in [0,1]
    def simple_score(a: str, b: str) -> float:
      sa = {t for t in a.lower().split() if t}
      sb = {t for t in b.lower().split() if t}
      if not sa or not sb:
        return 0.0
      inter = sa.intersection(sb)
      union = sa.union(sb)
      return float(len(inter)) / float(len(union))

    similarities = [simple_score(query, t) for t in texts]
    image_scores = [None for _ in thumbnails]

  combined_scores: List[float] = []
  for text_score, image_score in zip(similarities, image_scores):
    if image_score is None:
      combined_scores.append(text_score)
    else:
      combined_scores.append((text_score * TEXT_WEIGHT) + (image_score * IMAGE_WEIGHT))

  # Apply semantic disambiguation: aggressive filtering and boosting for accuracy
  adjusted_scores: List[float] = []
  query_lower = query.lower()
  
  for combined, title, description, text_score in zip(combined_scores, titles, descriptions, similarities):
    score = combined
    content_lower = f"{title} {description}".lower()
    
    # HARD FILTER: Reject music/entertainment content universally
    music_penalty_count = sum(1 for kw in MUSIC_KEYWORDS if kw in content_lower)
    if music_penalty_count >= 2:  # If 2+ music keywords, nearly eliminate
      score *= 0.05
    elif music_penalty_count == 1:
      score *= 0.3
    
    # Penalize brand keywords AGGRESSIVELY if query is multi-meaning word
    if query_lower in BRAND_KEYWORDS:
      brand_matches = sum(1 for kw in BRAND_KEYWORDS[query_lower] if kw in content_lower)
      if brand_matches >= 2:
        score *= 0.1  # Nearly eliminate if multiple brand keywords
      elif brand_matches == 1:
        score *= 0.15  # Heavy penalty for single brand keyword
    
    # Boost fruit/flower keywords with stacking
    boost_keywords = []
    if query_lower in FRUIT_KEYWORDS:
      boost_keywords = FRUIT_KEYWORDS[query_lower]
    elif query_lower in FLOWER_KEYWORDS:
      boost_keywords = FLOWER_KEYWORDS[query_lower]
    
    if boost_keywords:
      boost_matches = sum(1 for kw in boost_keywords if kw in content_lower)
      if boost_matches >= 3:
        score = min(score * 2.5, 1.0)  # Major boost for 3+ matches
      elif boost_matches == 2:
        score = min(score * 1.8, 1.0)
      elif boost_matches == 1:
        score = min(score * 1.3, 1.0)
    
    # Require minimum semantic similarity for text-based results
    if text_score < 0.15:  # Too low semantic relevance
      score *= 0.2
    
    adjusted_scores.append(max(score, 0.0))

  ranked = sorted(
    (
      {
        "id": id_value,
        "score": adjusted,
        "title": title,
        "text": text,
        "description": description,
        "thumbnail": thumbnail,
        "image_score": image_score,
        "text_score": text_score,
      }
      for id_value, adjusted, title, text, description, thumbnail, image_score, text_score in zip(
        ids,
        adjusted_scores,
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
  # Run without the reloader so the process stays single-threaded when launched
  # from the editor/terminal. The development reloader forks which can cause
  # the parent to exit in some tooling; disabling it keeps the server alive.
  app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False)
