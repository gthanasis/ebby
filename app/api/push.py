"""Web push: the key, subscribing, a test notification."""



from fastapi import APIRouter
from pydantic import BaseModel

from app.integrations import push

router = APIRouter()


@router.get("/api/push/key")
def push_key():
    return {"key": push.public_key()}


class PushSub(BaseModel):
    endpoint: str
    keys: dict[str, str]
    expirationTime: float | None = None


@router.post("/api/push/subscribe")
def push_subscribe(body: PushSub):
    push.subscribe(body.model_dump())
    return {"devices": push.count()}


class PushUnsub(BaseModel):
    endpoint: str


@router.post("/api/push/unsubscribe")
def push_unsubscribe(body: PushUnsub):
    push.unsubscribe(body.endpoint)
    return {"devices": push.count()}


@router.post("/api/push/test")
def push_test():
    sent = push.send("Notifications are on", "This is how cool-down alerts will reach you.", url="/#/plan", tag="test")
    return {"sent": sent}
