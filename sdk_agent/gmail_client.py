"""Gmail client — scans inbox for important messages."""

import base64
import re
from typing import Any

from googleapiclient.discovery import build

from .google_auth import get_credentials

_MAX_EMAILS = 20
_SNIPPET_MAX = 300


def get_important_emails() -> list[dict[str, Any]]:
    """Return up to 20 unread inbox messages from the last 24 hours."""
    creds = get_credentials()
    service = build("gmail", "v1", credentials=creds)

    results = (
        service.users()
        .messages()
        .list(
            userId="me",
            q="is:unread in:inbox newer_than:1d",
            maxResults=_MAX_EMAILS,
        )
        .execute()
    )

    messages = []
    for msg_ref in results.get("messages", []):
        msg = (
            service.users()
            .messages()
            .get(userId="me", id=msg_ref["id"], format="full")
            .execute()
        )
        messages.append(_parse_message(msg))

    return messages


def _parse_message(msg: dict) -> dict[str, Any]:
    headers = {h["name"]: h["value"] for h in msg["payload"].get("headers", [])}
    body = _extract_body(msg["payload"])
    snippet = msg.get("snippet", "")

    return {
        "id": msg["id"],
        "subject": headers.get("Subject", "(No subject)"),
        "from": headers.get("From", ""),
        "date": headers.get("Date", ""),
        "snippet": snippet[:_SNIPPET_MAX],
        "body_preview": _clean_text(body)[:_SNIPPET_MAX] if body else snippet[:_SNIPPET_MAX],
        "labels": msg.get("labelIds", []),
    }


def _extract_body(payload: dict) -> str:
    """Extract plain-text body from a message payload."""
    mime_type = payload.get("mimeType", "")

    if mime_type == "text/plain":
        data = payload.get("body", {}).get("data", "")
        if data:
            return base64.urlsafe_b64decode(data).decode("utf-8", errors="ignore")

    for part in payload.get("parts", []):
        result = _extract_body(part)
        if result:
            return result

    return ""


def _clean_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()
