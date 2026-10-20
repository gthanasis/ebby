"""The assistant's chat, its proposed actions, and the payment sorter."""

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.data import db
from app.domain import ai, assistant, insights, sorter
from app.domain.categories import CATEGORIES

router = APIRouter()


@router.get("/api/assistant")
def assistant_state():
    with db.connect() as conn:
        qs = insights.questions(conn)
        cash = insights.cash_view(conn, insights.this_month())
    return {**assistant.display(), "questions": qs, "cash": cash, "ai": ai.available()}


class ChatIn(BaseModel):
    text: str


@router.post("/api/assistant/chat")
def assistant_chat(body: ChatIn):
    if not body.text.strip():
        raise HTTPException(400, "Say something first")
    try:
        return assistant.chat(body.text.strip()[:2000])
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.post("/api/assistant/chat/stream")
def assistant_chat_stream(body: ChatIn):
    """The reply as it's written, as server-sent events: text, status, then done (or error)."""
    if not body.text.strip():
        raise HTTPException(400, "Say something first")

    def events():
        for event in assistant.chat_events(body.text.strip()[:2000]):
            yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/api/assistant/actions/{action_id}/confirm")
def assistant_confirm(action_id: int):
    try:
        result = assistant.run_action(action_id)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    return {"result": result, **assistant.display()}


@router.post("/api/assistant/actions/{action_id}/cancel")
def assistant_cancel(action_id: int):
    assistant.cancel_action(action_id)
    return assistant.display()


@router.post("/api/assistant/new")
def assistant_new():
    assistant.new_conversation()
    return assistant.display()


class AnswerIn(BaseModel):
    service: str
    category: str


@router.post("/api/assistant/answer")
def assistant_answer(body: AnswerIn):
    """Answer to "what was this?" for a payee left in Other: all its payments, now and later."""
    if body.category not in CATEGORIES:
        raise HTTPException(400, "Unknown category")
    with db.connect() as conn:
        moved = insights.set_service_category(conn, body.service, body.category)
        return {"moved": moved, "questions": insights.questions(conn)}


@router.get("/api/sorter")
def sorter_items():
    with db.connect() as conn:
        return {"items": sorter.items(conn), "ai": ai.available()}


class GuessIn(BaseModel):
    service: str


@router.post("/api/sorter/undo")
def sorter_undo(body: GuessIn):
    """Take back an answer: the payee's rules go, so its payments are worked out as before."""
    with db.connect() as conn:
        return {"moved": insights.clear_service_category(conn, body.service)}


@router.post("/api/sorter/guess")
def sorter_guess(body: GuessIn):
    with db.connect() as conn:
        g = sorter.guess(conn, body.service)
    if not g:
        raise HTTPException(502, "The assistant couldn't make a guess for this one.")
    return g
