from __future__ import annotations

import io
import logging
from collections import OrderedDict
from typing import Any, Dict, List, Optional

import requests
from flask import Flask, jsonify, request
from PIL import Image

import os
import json
from collections import Counter

# Use a lightweight pure-Python scorer by default so the backend starts
# quickly for local extension testing. Set environment variable
# `AIS_ENABLE_ML=1` to attempt loading heavy ML libraries instead.
USE_FALLBACK = os.environ.get("AIS_ENABLE_ML", "0") != "1"
SentenceTransformer = None
util = None
torch = None
TfidfVectorizer = None
LogisticRegression = None
if not USE_FALLBACK:
  try:
    import torch
    from sentence_transformers import SentenceTransformer, util
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
  except Exception as exc:  # pragma: no cover - runtime fallback
    USE_FALLBACK = True
    SentenceTransformer = None
    util = None
    torch = None
    TfidfVectorizer = None
    LogisticRegression = None
    logging.warning("ML imports failed, using fallback text scorer: %s", exc)

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

# all-mpnet-base-v2 provides superior semantic understanding with deeper contextual
# meaning compared to MiniLM. It's slower but much more accurate for NLU tasks.
MODEL_NAME = "all-mpnet-base-v2"
SECONDARY_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
CLIP_MODEL_NAME = "clip-ViT-B-32"
# Prioritize text semantic understanding (60%) over image (40%) for better accuracy
TEXT_WEIGHT = float(os.environ.get("AIS_TEXT_WEIGHT", "0.6"))
IMAGE_WEIGHT = float(os.environ.get("AIS_IMAGE_WEIGHT", "0.4"))
IMAGE_CACHE_MAX = 128

# Use multi-model ensemble if enabled
USE_ENSEMBLE = os.environ.get("AIS_USE_ENSEMBLE", "0") == "1"
ENSEMBLE_WEIGHTS = [0.6, 0.4]  # Weight primary model (all-mpnet) 60%, secondary (MiniLM) 40%

# Query intent classification: detect user intent and adjust weights
INTENT_KEYWORDS = {
  "how_to": [
    "how to", "tutorial", "guide", "step by step", "diy", "learn", "teaching",
    "instructions", "howto", "tips", "tricks", "process", "method", "technique"
  ],
  "review": [
    "review", "unboxing", "comparison", "vs", "testing", "benchmark", "opinion",
    "thoughts", "honest review", "hands on", "rating", "verdict"
  ],
  "entertainment": [
    "funny", "comedy", "entertainment", "reaction", "try", "challenge", "prank",
    "viral", "trending", "music", "song", "dance", "skit"
  ],
  "factual": [
    "facts", "documentary", "explained", "science", "research", "study", "analysis",
    "data", "statistics", "information", "news", "education", "learning"
  ]
}

# Intent weight adjustments: how much to boost different content types
INTENT_WEIGHTS = {
  "how_to": 1.3,      # Users searching "how to" want tutorials
  "review": 1.2,      # Reviews are trusted for product queries
  "entertainment": 0.7,  # Generally deprioritize entertainment
  "factual": 1.2      # Factual content is valuable
}

# Temporal recency keywords: used to detect if content is recent
RECENCY_KEYWORDS = {
  "very_recent": ["just now", "hours ago", "today"],
  "recent": ["yesterday", "days ago", "this week", "week ago"],
  "somewhat_recent": ["weeks ago", "last month", "month ago"],
  "old": ["months ago", "years ago", "years"]
}

# Semantic disambiguation: map queries to brand/company keywords (penalize) and fruit/natural keywords (boost)
BRAND_KEYWORDS = {
  "apple": [
    "iphone", "ipad", "ipod", "macbook", "macbook pro", "macbook air", "mac", "imac",
    "mac mini", "mac studio", "mac pro", "ios", "ios 17", "ios 18", "macos", "app store",
    "tim cook", "steve jobs", "cupertino", "wozniak", "event", "keynote", "apple event",
    "wwdc", "airpods", "airpods pro", "watch", "apple watch", "airplay", "siri", "icloud",
    "apple silicon", "m1", "m2", "m3", "a17", "a18", "vision pro", "battery", "charge",
    "upgrade", "itunes", "safari", "facetime", "imessage", "apple tv", "airtag", "homepod",
    "unboxing", "review", "aapl", "stock", "earnings", "preorder"
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
    "peel", "slice", "eat", "snack", "fuji", "granny smith", "gala", "honeycrisp",
    "fruit salad", "caramel apple", "apple fruit", "malus", "orchard care"
  ],
  "orange": [
    "fruit", "citrus", "tree", "orchard", "vitamin c", "juice", "peel",
    "zest", "sweet", "taste", "recipe", "health", "fresh", "segment"
  ],
  "cherry": [
    "fruit", "tree", "orchard", "picking", "recipe", "pie", "sweet", "tart", "fresh"
  ]
}

# Topic/entity categories: map keywords to semantic categories for filtering
TOPIC_CATEGORIES = {
  "FRUIT": [
    "fruit", "orchard", "tree", "harvest", "farming", "crop", "agriculture",
    "berry", "citrus", "tropical", "produce", "plant", "organic", "fresh",
    "pie", "juice", "recipe", "cooking", "baking", "eat", "snack"
  ],
  "TECHNOLOGY": [
    "tech", "device", "gadget", "smartphone", "computer", "software", "app",
    "iphone", "macbook", "ipad", "watch", "processor", "chip", "silicon",
    "review", "unboxing", "keynote", "announcement", "launch", "feature"
  ],
  "PERSON": [
    "steve jobs", "tim cook", "founder", "ceo", "executive", "developer",
    "artist", "musician", "comedian", "actor", "celebrity", "influencer",
    "interview", "talk", "discussion", "biography"
  ],
  "ENTERTAINMENT": [
    "funny", "comedy", "entertainment", "reaction", "try", "challenge",
    "prank", "viral", "music", "song", "dance", "skit", "movie", "show"
  ]
}

# Define which categories conflict (can't both be relevant)
CONFLICTING_CATEGORIES = [
  ("FRUIT", "TECHNOLOGY"),
  ("FRUIT", "ENTERTAINMENT"),
  ("FRUIT", "PERSON")  # Unless person is a farmer
]

# Universal music/entertainment keywords to filter out - EXPANDED to catch all variations
MUSIC_KEYWORDS = [
  "lyrics", "lyric", "official video", "music video", "audio", "song", "remix", "cover",
  "vevo", "karaoke", "live performance", "concert", "acoustic", "instrumental",
  "mv", "official mv", "topic", "feat", "ft.", "album", "single", "track",
  "playlist", "spotify", "apple music", "lyric video", "lyrics video", "official lyric",
  "clean version", "clean -", "explicit", "male version", "female version", "cover nation",
  "trending tracks", "music", "singer", "artist", "band", "performance", "live",
  "official audio", "visualizer", "music visualizer", "letra", "legendado", "tradução",
  "reaction", "reacts to", "first time hearing", "breakdown", "analysis music",
  "music review", "vocal coach", "samantha ebert", "lauren spencer smith", "miley cyrus",
  "donzell taggart", "sing king", "karaoke version", "instrumental version"
]

# Cross-modal validation: keywords that should match between text and image
VISUAL_VALIDATION_KEYWORDS = {
  "apple_fruit": ["apple", "apples", "red apple", "green apple", "fruit"],
  "apple_tech": ["iphone", "macbook", "ipad", "apple watch", "airpods", "mac", "apple logo"],
  "flower": ["flower", "flowers", "rose", "tulip", "daisy", "bouquet"],
  "food": ["food", "cooking", "recipe", "dish", "meal"]
}

# Flower-related keywords for "flowers" query
FLOWER_KEYWORDS = {
  "flowers": [
    "garden", "bouquet", "bloom", "blossom", "petal", "plant", "growing",
    "florist", "arrangement", "wildflower", "rose", "tulip", "daisy", "lily",
    "sunflower", "orchid", "care", "planting", "gardening", "seeds", "soil",
    "water", "nature", "floral", "botanical", "crochet", "knitting", "craft",
    "diy", "tutorial", "how to make", "handmade", "origami", "paper flowers",
    "fabric flowers", "felt", "beading", "art", "painting", "drawing", "photography",
    "landscaping", "perennial", "annual", "fertilizer", "pruning", "cutting",
    "greenhouse", "flower bed", "wedding flowers", "dried flowers"
  ]
}

# Query expansion: for ambiguous queries, generate semantic variants to improve recall
QUERY_EXPANSIONS = {
  "apple": [
    "apple fruit",
    "apple orchard",
    "apple recipe",
    "apple pie",
    "apple cider",
    "apple juice",
    "apple harvest",
    "apple farming"
  ],
  "orange": [
    "orange fruit",
    "orange citrus",
    "orange juice",
    "orange orchard",
    "orange recipes"
  ],
  "cherry": [
    "cherry fruit",
    "cherry tree",
    "cherry picking",
    "cherry recipe",
    "cherry harvest"
  ],
  "banana": [
    "banana fruit",
    "banana recipe",
    "banana bread",
    "banana smoothie"
  ],
  "flower": [
    "flower gardening",
    "flower arrangements",
    "flower planting",
    "flower care",
    "flower growing"
  ]
}

# If the heavy models loaded successfully, instantiate them. Otherwise
# keep None and the code will use a simple fallback scorer.
model = None
secondary_model = None
clip_model = None
if not USE_FALLBACK:
  model = SentenceTransformer(MODEL_NAME)
  if USE_ENSEMBLE:
    try:
      secondary_model = SentenceTransformer(SECONDARY_MODEL_NAME)
    except Exception as e:
      logging.warning("Failed to load secondary model for ensemble: %s", e)
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

# Negative keyword classifier (trained from user feedback)
negative_classifier = None
negative_vectorizer = None
learned_negative_keywords: List[str] = []

# Query embedding cache: store recent query embeddings to speed up repeated searches
class EmbeddingCache:
  def __init__(self, max_size: int = 256) -> None:
    self._store: OrderedDict[str, torch.Tensor] = OrderedDict()
    self._max_size = max_size

  def get(self, key: str) -> Optional[torch.Tensor]:
    if key in self._store:
      self._store.move_to_end(key)
      return self._store[key]
    return None

  def set(self, key: str, value: torch.Tensor) -> None:
    if key in self._store:
      del self._store[key]
    self._store[key] = value
    self._store.move_to_end(key)
    if len(self._store) > self._max_size:
      self._store.popitem(last=False)

  def clear(self) -> None:
    self._store.clear()

query_embedding_cache = EmbeddingCache(max_size=256)


def detect_query_intent(query: str) -> str:
  """Detect user's intent from query to adjust scoring."""
  query_lower = query.lower()
  
  # Count keyword matches for each intent
  intent_scores = {intent: 0 for intent in INTENT_KEYWORDS}
  for intent, keywords in INTENT_KEYWORDS.items():
    intent_scores[intent] = sum(1 for kw in keywords if kw in query_lower)
  
  # Return the intent with most matches, default to "factual"
  best_intent = max(intent_scores.items(), key=lambda x: x[1])
  return best_intent[0] if best_intent[1] > 0 else "factual"


def detect_recency(metadata: str) -> float:
  """Detect content recency from metadata and return boost multiplier."""
  metadata_lower = metadata.lower()
  
  # Check for very recent content (boost heavily)
  if any(kw in metadata_lower for kw in RECENCY_KEYWORDS.get("very_recent", [])):
    return 1.5  # 50% boost for content from today/hours ago
  
  # Check for recent content (moderate boost)
  if any(kw in metadata_lower for kw in RECENCY_KEYWORDS.get("recent", [])):
    return 1.3  # 30% boost for week-old content
  
  # Check for somewhat recent (slight boost)
  if any(kw in metadata_lower for kw in RECENCY_KEYWORDS.get("somewhat_recent", [])):
    return 1.1  # 10% boost for month-old content
  
  # Default: no boost for older content
  return 1.0


def detect_topics(text: str) -> List[str]:
  """Detect semantic topics/entities in text using keyword matching."""
  text_lower = text.lower()
  detected = []
  
  for category, keywords in TOPIC_CATEGORIES.items():
    if any(kw in text_lower for kw in keywords):
      detected.append(category)
  
  return detected


def apply_topic_filtering(score: float, content_topics: List[str], query_intent: str) -> float:
  """Apply hard filtering based on conflicting topics."""
  if not content_topics:
    return score
  
  # For fruit queries, strongly penalize tech + entertainment combos
  if query_intent == "factual" and "FRUIT" not in content_topics:
    if "TECHNOLOGY" in content_topics:
      return score * 0.01  # 99% penalty for tech when expecting fruit
    if "ENTERTAINMENT" in content_topics:
      return score * 0.1   # 90% penalty for entertainment
  
  return score


def train_negative_classifier(feedback_data: List[Dict[str, Any]]) -> None:
  """Train classifier on user feedback to identify negative patterns."""
  global negative_classifier, negative_vectorizer, learned_negative_keywords
  
  if USE_FALLBACK or not TfidfVectorizer or not LogisticRegression:
    return
  
  if len(feedback_data) < 10:  # Need minimum data to train
    return
  
  # Extract texts and labels (1 = good, 0 = bad)
  texts = [item.get('title', '') + ' ' + item.get('description', '') for item in feedback_data]
  labels = [1 if item.get('feedback') == 'up' else 0 for item in feedback_data]
  
  # Balance check: need both positive and negative examples
  if sum(labels) == 0 or sum(labels) == len(labels):
    return
  
  try:
    # Train TF-IDF vectorizer and logistic regression
    negative_vectorizer = TfidfVectorizer(max_features=200, ngram_range=(1, 2), stop_words='english')
    X = negative_vectorizer.fit_transform(texts)
    
    negative_classifier = LogisticRegression(max_iter=500, random_state=42)
    negative_classifier.fit(X, labels)
    
    # Extract top negative keywords (high coefficient for class 0)
    feature_names = negative_vectorizer.get_feature_names_out()
    coefs = negative_classifier.coef_[0]
    negative_indices = coefs.argsort()[:30]  # Top 30 negative indicators
    learned_negative_keywords = [feature_names[i] for i in negative_indices]
    
    logging.info(f"Trained negative classifier on {len(feedback_data)} samples. Top negative keywords: {learned_negative_keywords[:10]}")
  except Exception as e:
    logging.warning(f"Failed to train negative classifier: {e}")


def predict_negative_score(text: str) -> float:
  """Predict probability that content is 'bad' based on learned patterns. Returns 0-1."""
  if not negative_classifier or not negative_vectorizer:
    return 0.0
  
  try:
    X = negative_vectorizer.transform([text])
    prob_negative = negative_classifier.predict_proba(X)[0][0]  # Probability of class 0 (bad)
    return float(prob_negative)
  except Exception:
    return 0.0


def validate_image_text_consistency(title: str, description: str, image_url: str, query: str) -> float:
  """
  Use CLIP to detect when image contradicts text content.
  Returns penalty multiplier: 1.0 (no penalty) to 0.1 (strong penalty).
  """
  if USE_FALLBACK or not clip_model or not image_url:
    return 1.0
  
  query_lower = query.lower()
  content_text = f"{title} {description}".lower()
  
  # Only validate for queries where we have clear visual expectations
  validation_category = None
  if "apple" in query_lower:
    if any(kw in content_text for kw in ["fruit", "nutrition", "healthy", "organic", "orchard"]):
      validation_category = "apple_fruit"
    elif any(kw in content_text for kw in ["iphone", "mac", "ios", "tech", "device"]):
      validation_category = "apple_tech"
  elif "flower" in query_lower:
    validation_category = "flower"
  
  if not validation_category:
    return 1.0
  
  try:
    # Get expected visual keywords for this category
    expected_visuals = VISUAL_VALIDATION_KEYWORDS.get(validation_category, [])
    
    # Use CLIP to score image against expected visual concepts
    clip_scores = []
    for visual_keyword in expected_visuals[:3]:  # Check top 3 keywords
      score = compute_image_score(image_url, clip_model.encode([visual_keyword], convert_to_tensor=True)[0])
      if score is not None:
        clip_scores.append(score)
    
    if not clip_scores:
      return 1.0
    
    avg_visual_match = sum(clip_scores) / len(clip_scores)
    
    # If image doesn't match expected visual (< 0.25), apply penalty
    if avg_visual_match < 0.25:
      return 0.3  # 70% penalty for visual mismatch
    elif avg_visual_match < 0.35:
      return 0.7  # 30% penalty for weak visual match
    
    return 1.0  # No penalty, image matches expectations
    
  except Exception as e:
    logging.warning(f"Cross-modal validation failed: {e}")
    return 1.0  # Don't penalize on errors



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


@app.route("/match_tags", methods=["POST", "OPTIONS"])
def match_tags() -> Any:
  """Match videos against user-provided tags using semantic similarity."""
  if request.method == "OPTIONS":
    preflight = app.make_response(("", 204))
    return preflight
  
  payload = request.get_json(force=True, silent=True) or {}
  tags = payload.get("tags", [])
  videos = payload.get("videos", [])
  min_score = payload.get("minScore", 70) / 100.0  # Convert percentage to 0-1
  
  if not tags or not videos:
    response = jsonify({"error": "Missing tags or videos"})
    response.status_code = 400
    return response
  
  logging.info(f"Matching {len(videos)} videos against tags: {tags}")
  
  matches = []
  
  for video in videos:
    try:
      # Extract title first (always needed)
      title = video.get('title', '')
      
      # Combine video text fields - support both formats
      if 'text' in video and video['text']:
        # Frontend sends pre-combined text field
        video_text = video['text'].lower()
      else:
        # Or build from individual fields
        description = video.get('description', '')
        metadata = video.get('metadata', '')
        video_text = f"{title} {description} {metadata}".lower()
      
      # Skip if no text
      if not video_text.strip():
        continue
      
      # Calculate semantic similarity between tags and video
      text_score = 0.0
      image_score = 0.0
      matched_tags = []
      
      if USE_FALLBACK:
        # Simple keyword matching for fallback - more lenient
        for tag in tags:
          tag_lower = tag.lower()
          if tag_lower in video_text:
            matched_tags.append(tag)
            text_score += 0.3  # Each keyword match adds 30%
        
        # Cap at 1.0
        text_score = min(text_score, 1.0)
        
      else:
        # Use sentence transformers for semantic matching
        # Check each tag individually for better matching
        max_tag_score = 0.0
        tag_scores = {}  # Track each tag's score for debugging
        
        for tag in tags:
          tag_lower = tag.lower()
          
          # Direct keyword match gets highest score
          if tag_lower in video_text:
            matched_tags.append(tag)
            max_tag_score = max(max_tag_score, 0.8)
            tag_scores[tag] = 0.8
          else:
            # Semantic similarity check
            try:
              tag_emb = primary_model.encode(tag_lower, convert_to_tensor=True)
              video_emb = primary_model.encode(video_text, convert_to_tensor=True)
              tag_sim = util.pytorch_cos_sim(tag_emb, video_emb)
              similarity = float(tag_sim[0][0])
              tag_scores[tag] = similarity
              
              # Lower threshold for tag matching - 0.15 instead of 0.25 (even more lenient)
              if similarity > 0.15:
                matched_tags.append(tag)
                max_tag_score = max(max_tag_score, similarity)
            except Exception as e:
              logging.debug(f"Error encoding tag {tag}: {e}")
        
        # Log tag scores for debugging
        if tag_scores:
          best_tag = max(tag_scores, key=tag_scores.get)
          logging.info(f"  Tag scores: {best_tag}={tag_scores[best_tag]:.2f}, all={tag_scores}")
        
        text_score = max_tag_score
        
        # Also try overall semantic similarity
        try:
          tags_text = " ".join(tags).lower()
          tags_embedding = primary_model.encode(tags_text, convert_to_tensor=True)
          video_embedding = primary_model.encode(video_text, convert_to_tensor=True)
          overall_similarity = util.pytorch_cos_sim(tags_embedding, video_embedding)
          overall_score = float(overall_similarity[0][0])
          
          # Use the better of individual tag matching or overall matching
          text_score = max(text_score, overall_score)
        except Exception as e:
          logging.debug(f"Error in overall similarity: {e}")
        
        # Try image matching if thumbnail available
        thumbnail_url = video.get('thumbnail', '')
        if thumbnail_url and clip_model and clip_processor:
          try:
            image_embedding = get_image_embedding_cached(thumbnail_url)
            if image_embedding is not None:
              tags_text = " ".join(tags).lower()
              clip_tags_input = clip_processor(text=[tags_text], return_tensors="pt", padding=True, truncation=True)
              with torch.no_grad():
                clip_tags_embedding = clip_model.get_text_features(**clip_tags_input)
                clip_tags_embedding /= clip_tags_embedding.norm(dim=-1, keepdim=True)
              
              image_similarity = torch.nn.functional.cosine_similarity(
                clip_tags_embedding,
                image_embedding,
                dim=1
              )
              image_score = float(image_similarity[0])
          except Exception as img_err:
            logging.debug(f"Image matching failed: {img_err}")
      
      # Combine text and image scores (prioritize text for tag matching)
      combined_score = (text_score * 0.7) + (image_score * 0.3)
      
      # Log first few for debugging
      if len(matches) < 3:
        logging.info(f"Video '{title[:50]}...' - Text: {text_score:.2f}, Image: {image_score:.2f}, Combined: {combined_score:.2f}, Tags: {matched_tags}")
      
      # Only include if score meets minimum
      if combined_score >= min_score:
        matches.append({
          "id": video.get("id"),
          "title": title,
          "url": video.get("url"),
          "thumbnail": video.get("thumbnail"),
          "score": round(combined_score * 100, 1),
          "matchedTags": matched_tags if matched_tags else tags[:2]  # Show first 2 tags if none explicitly matched
        })
    
    except Exception as e:
      logging.warning(f"Error matching video {video.get('id')}: {e}")
      continue
  
  # Sort by score descending
  matches.sort(key=lambda x: x["score"], reverse=True)
  
  logging.info(f"Found {len(matches)} / {len(videos)} videos matching tags (min score: {min_score * 100}%)")
  
  return jsonify({
    "matches": matches,
    "total_analyzed": len(videos),
    "total_matched": len(matches)
  })


@app.route("/feedback", methods=["POST", "OPTIONS"])
def feedback() -> Any:
  """Receive user feedback and retrain negative classifier."""
  if request.method == "OPTIONS":
    preflight = app.make_response(("", 204))
    return preflight
  
  payload = request.get_json(force=True, silent=True) or {}
  feedback_data = payload.get("feedback_data") or []
  
  if not feedback_data:
    response = jsonify({"error": "Missing feedback_data"})
    response.status_code = 400
    return response
  
  # Train classifier on new feedback
  train_negative_classifier(feedback_data)
  
  return jsonify({
    "status": "ok",
    "samples": len(feedback_data),
    "learned_keywords": learned_negative_keywords[:10]
  })


@app.route("/search", methods=["POST", "OPTIONS"])
def search() -> Any:
  if request.method == "OPTIONS":
    preflight = app.make_response(("", 204))
    return preflight
  payload = request.get_json(force=True, silent=True) or {}
  query = (payload.get("query") or "").strip()
  items: List[Dict[str, Any]] = payload.get("items") or []
  feedback_history = payload.get("feedback") or {"positive": [], "negative": []}

  if not query or not items:
    response = jsonify({"error": "Missing query or items"})
    response.status_code = 400
    return response

  texts = []
  ids = []
  titles = []
  descriptions = []
  thumbnails = []
  metadata_list = []
  for item in items:
    text = (item.get("text") or "").strip()
    if not text:
      continue
    texts.append(text)
    ids.append(item.get("id"))
    titles.append(item.get("title") or "")
    descriptions.append(item.get("description") or "")
    thumbnails.append(item.get("thumbnail") or "")
    metadata_list.append(item.get("metadata") or "")

  if not texts:
    response = jsonify({"error": "No valid text items"})
    response.status_code = 400
    return response

  # Query expansion: for ambiguous queries, also score against expanded variants
  query_lower = query.lower()
  expansion_queries = [query]
  if query_lower in QUERY_EXPANSIONS:
    expansion_queries.extend(QUERY_EXPANSIONS[query_lower])

  # Compute text similarities. Use the sentence-transformers model when
  # available, otherwise fall back to a lightweight token-overlap scorer.
  if model is not None and util is not None and torch is not None:
    # Encode all query variants with caching to speed up repeated searches
    query_embeddings = []
    for q in expansion_queries:
      cached = query_embedding_cache.get(q)
      if cached is not None:
        query_embeddings.append(cached)
      else:
        emb = model.encode(q, convert_to_tensor=True, normalize_embeddings=True)
        query_embedding_cache.set(q, emb)
        query_embeddings.append(emb)

    item_embeddings = model.encode(texts, convert_to_tensor=True, normalize_embeddings=True)
    # For each item, find max similarity across all query variants
    similarities = []
    for item_emb in item_embeddings:
      max_sim = max(
        util.cos_sim(qe, item_emb.unsqueeze(0))[0][0].item()
        for qe in query_embeddings
      )
      similarities.append(max_sim)
    
    # Multi-model ensemble: also score with secondary model if available
    if USE_ENSEMBLE and secondary_model is not None:
      secondary_embeddings = secondary_model.encode(texts, convert_to_tensor=True, normalize_embeddings=True)
      # Encode queries with secondary model (must match dimensions)
      secondary_query_embeddings = [
        secondary_model.encode(q, convert_to_tensor=True, normalize_embeddings=True)
        for q in expansion_queries
      ]
      secondary_similarities = []
      for item_emb in secondary_embeddings:
        max_sim = max(
          util.cos_sim(qe, item_emb.unsqueeze(0))[0][0].item()
          for qe in secondary_query_embeddings  # Use secondary model embeddings
        )
        secondary_similarities.append(max_sim)
      # Weighted ensemble: 60% primary, 40% secondary
      similarities = [
        primary * ENSEMBLE_WEIGHTS[0] + secondary * ENSEMBLE_WEIGHTS[1]
        for primary, secondary in zip(similarities, secondary_similarities)
      ]
    
    similarities = similarities

    clip_queries = clip_model.encode(
      expansion_queries,
      convert_to_tensor=True,
      normalize_embeddings=True,
      show_progress_bar=False,
    )

    image_scores: List[Optional[float]] = []
    for thumbnail in thumbnails:
      image_scores.append(compute_image_score_expanded(thumbnail, clip_queries))
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

    # For fallback, score against all expansion variants and take max
    similarities = [
      max(simple_score(q, t) for q in expansion_queries)
      for t in texts
    ]
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
  
  # Detect query intent to adjust scoring
  detected_intent = detect_query_intent(query_lower)
  intent_weight = INTENT_WEIGHTS.get(detected_intent, 1.0)
  
  for combined, title, description, text_score, metadata, thumbnail in zip(combined_scores, titles, descriptions, similarities, metadata_list, thumbnails):
    score = combined
    content_lower = f"{title} {description}".lower()
    
    # Apply temporal recency boosting (especially for trending queries)
    recency_boost = detect_recency(metadata)
    score *= recency_boost
    
    # Detect topics in content and apply hard filtering for conflicts
    content_topics = detect_topics(content_lower)
    score = apply_topic_filtering(score, content_topics, detected_intent)
    
    # Cross-modal validation: penalize if image contradicts text
    visual_consistency = validate_image_text_consistency(title, description, thumbnail, query)
    score *= visual_consistency
    
    # Apply learned negative keyword penalty from user feedback
    negative_prob = predict_negative_score(content_lower)
    if negative_prob > 0.6:  # High confidence this is bad content
      score *= (1.0 - negative_prob)  # Penalize proportionally
    
    # Similarity-based feedback learning: compare to historical feedback
    if feedback_history and model is not None and util is not None:
      current_text = f"{title} {description}"
      
      # Compare to negative feedback (thumbs down)
      negative_items = feedback_history.get("negative", [])
      if negative_items:
        max_negative_sim = 0.0
        for neg_item in negative_items[:20]:  # Limit to recent 20
          neg_text = f"{neg_item.get('title', '')} {neg_item.get('description', '')}"
          if neg_text.strip():
            neg_emb = model.encode(neg_text, convert_to_tensor=True, normalize_embeddings=True)
            curr_emb = model.encode(current_text, convert_to_tensor=True, normalize_embeddings=True)
            sim = util.cos_sim(neg_emb.unsqueeze(0), curr_emb.unsqueeze(0))[0][0].item()
            max_negative_sim = max(max_negative_sim, sim)
        
        # If very similar to thumbs-down content (>0.75), heavily penalize
        if max_negative_sim > 0.75:
          score *= 0.1  # 90% penalty for very similar to disliked content
        elif max_negative_sim > 0.6:
          score *= 0.4  # 60% penalty for moderately similar
        elif max_negative_sim > 0.45:
          score *= 0.7  # 30% penalty for somewhat similar
      
      # Compare to positive feedback (thumbs up)
      positive_items = feedback_history.get("positive", [])
      if positive_items:
        max_positive_sim = 0.0
        for pos_item in positive_items[:20]:  # Limit to recent 20
          pos_text = f"{pos_item.get('title', '')} {pos_item.get('description', '')}"
          if pos_text.strip():
            pos_emb = model.encode(pos_text, convert_to_tensor=True, normalize_embeddings=True)
            curr_emb = model.encode(current_text, convert_to_tensor=True, normalize_embeddings=True)
            sim = util.cos_sim(pos_emb.unsqueeze(0), curr_emb.unsqueeze(0))[0][0].item()
            max_positive_sim = max(max_positive_sim, sim)
        
        # If very similar to thumbs-up content (>0.75), strongly boost
        if max_positive_sim > 0.75:
          score = min(score * 2.5, 1.0)  # 150% boost for very similar to liked content
        elif max_positive_sim > 0.6:
          score = min(score * 1.8, 1.0)  # 80% boost for moderately similar
        elif max_positive_sim > 0.45:
          score = min(score * 1.3, 1.0)  # 30% boost for somewhat similar
    
    # HARD FILTER: Completely eliminate music/entertainment content for non-music queries
    is_music_query = any(kw in query_lower for kw in ["song", "music", "singer", "band", "album", "lyrics"])
    music_penalty_count = sum(1 for kw in MUSIC_KEYWORDS if kw in content_lower)
    music_penalty_applied = False
    
    if not is_music_query:  # Only penalize music if query isn't music-related
      if music_penalty_count >= 1:  # ANY music keyword = complete elimination
        score = 0.0  # Completely remove music videos
        music_penalty_applied = True
    
    # Apply intent-based weighting
    # If query intent is "how_to" but content has no tutorial keywords, penalize
    if detected_intent == "how_to":
      has_howto = any(kw in content_lower for kw in INTENT_KEYWORDS["how_to"])
      if has_howto:
        score *= 1.5  # Strong boost for tutorials when user wants howto
      else:
        score *= 0.8  # Slight penalty if not tutorial-like
    elif detected_intent == "review":
      has_review = any(kw in content_lower for kw in INTENT_KEYWORDS["review"])
      if has_review:
        score *= 1.3
      else:
        score *= 0.85
    
    # For ambiguous queries like "apple", check if ANY fruit keywords exist
    # If NO fruit keywords found, assume it's brand content and penalize heavily
    if query_lower in FRUIT_KEYWORDS:
      boost_keywords = FRUIT_KEYWORDS[query_lower]
      boost_matches = sum(1 for kw in boost_keywords if kw in content_lower)
      brand_matches = sum(1 for kw in BRAND_KEYWORDS.get(query_lower, []) if kw in content_lower)

      # If NO fruit keywords present, assume it's brand/tech and nuke the score
      if boost_matches == 0:
        if brand_matches > 0:
          score = 0.0  # hard reject brand/tech when no fruit context
        else:
          score *= 0.01   # 99% penalty: no fruit keywords at all

      # If brand keywords present even with some fruit, still penalize
      elif brand_matches >= 2:
        score *= 0.02  # 98% penalty for multiple brand keywords
      elif brand_matches == 1:
        score *= 0.05  # 95% penalty for single brand keyword

      # Strong boost for fruit keywords when present
      if boost_matches >= 3:
        score = min(score * 4.0, 1.0)  # Major boost for 3+ matches
      elif boost_matches == 2:
        score = min(score * 3.0, 1.0)
      elif boost_matches == 1:
        score = min(score * 2.0, 1.0)
    
    # Boost flower keywords with stacking - prioritize craft/DIY/gardening content
    # Don't apply "no keywords" penalty if music penalty already applied (avoid double-penalty)
    elif query_lower in FLOWER_KEYWORDS:
      boost_keywords = FLOWER_KEYWORDS[query_lower]
      boost_matches = sum(1 for kw in boost_keywords if kw in content_lower)
      
      # If NO flower keywords at all AND not already music-penalized, penalize
      if boost_matches == 0 and not music_penalty_applied:
        score *= 0.1  # 90% penalty (less aggressive than before)
      # Strong progressive boost for flower content
      elif boost_matches >= 5:
        score = min(score * 6.0, 1.0)  # Massive boost for 5+ matches (detailed craft/gardening)
      elif boost_matches == 4:
        score = min(score * 4.5, 1.0)
      elif boost_matches == 3:
        score = min(score * 3.5, 1.0)
      elif boost_matches == 2:
        score = min(score * 2.5, 1.0)
      elif boost_matches == 1:
        score = min(score * 1.8, 1.0)
    
    # Require minimum semantic similarity for text-based results
    if text_score < 0.2:  # Raised from 0.15 - stricter filtering
      score *= 0.15
    
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

  response = jsonify({"ranked": ranked, "query_intent": detected_intent})
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


def compute_image_score_expanded(url: str, clip_queries: torch.Tensor) -> Optional[float]:
  """Compute max image score across expanded query variants."""
  if not url:
    return None
  embedding = fetch_image_embedding(url)
  if embedding is None:
    return None
  with torch.no_grad():
    max_score = max(
      util.cos_sim(qe.unsqueeze(0), embedding.unsqueeze(0))[0][0].item()
      for qe in clip_queries
    )
  return normalize_clip_score(max_score)


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
