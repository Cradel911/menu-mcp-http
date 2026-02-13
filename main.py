import os
import io
import re
from typing import List, Tuple, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException
from pypdf import PdfReader

app = FastAPI()

SET_MENU_URL = os.environ["SET_MENU_URL"]
API_KEY = os.environ.get("API_KEY")  # optional

_cached_text: Optional[str] = None

def require_auth(authorization: Optional[str]):
    if not API_KEY:
        return
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Unauthorized")

async def download_pdf(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content

def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    text = "\n".join(parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

async def get_set_menu_text(force_refresh: bool = False) -> str:
    global _cached_text
    if _cached_text and not force_refresh:
        return _cached_text

    pdf_bytes = await download_pdf(SET_MENU_URL)
    _cached_text = extract_text_from_pdf(pdf_bytes)
    return _cached_text

def chunk_text(text: str, max_chars: int = 1200) -> List[str]:
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks = []
    buf = ""
    for p in paras:
        if len(buf) + len(p) + 2 <= max_chars:
            buf = (buf + "\n\n" + p).strip()
        else:
            if buf:
                chunks.append(buf)
            buf = p
    if buf:
        chunks.append(buf)
    return chunks

def score_chunk(chunk: str, question: str) -> int:
    terms = [t for t in re.findall(r"[a-zA-Z0-9]+", question.lower()) if len(t) > 2]
    c = chunk.lower()
    return sum(c.count(t) for t in terms)

def get_relevant_context(menu_text: str, question: str, k: int = 4) -> List[str]:
    chunks = chunk_text(menu_text)
    scored: List[Tuple[int, str]] = [(score_chunk(ch, question), ch) for ch in chunks]
    scored.sort(key=lambda x: x[0], reverse=True)
    best = [ch for s, ch in scored[:k] if s > 0]
    return best if best else chunks[:2]

@app.get("/health")
async def health():
    return {"ok": True}

@app.post("/menu/context")
async def menu_context(
    payload: dict,
    authorization: Optional[str] = Header(default=None),
):
    require_auth(authorization)

    question = (payload.get("question") or "").strip()
    refresh = bool(payload.get("refresh", False))

    if not question:
        raise HTTPException(status_code=400, detail="Missing 'question'")

    menu_text = await get_set_menu_text(force_refresh=refresh)
    context = get_relevant_context(menu_text, question, k=4)

    return {
        "menu": "set",
        "source_url": SET_MENU_URL,
        "context": context,
    }

@app.post("/menu/refresh")
async def menu_refresh(authorization: Optional[str] = Header(default=None)):
    require_auth(authorization)
    await get_set_menu_text(force_refresh=True)
    return {"ok": True, "menu": "set"}