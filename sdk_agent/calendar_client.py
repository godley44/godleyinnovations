"""Google Calendar client — fetches today's events."""

from datetime import datetime, timezone
from typing import Any

from googleapiclient.discovery import build

from .google_auth import get_credentials


def get_todays_events() -> list[dict[str, Any]]:
    """Return a list of today's calendar events sorted by start time."""
    creds = get_credentials()
    service = build("calendar", "v3", credentials=creds)

    now = datetime.now(timezone.utc)
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_of_day = now.replace(hour=23, minute=59, second=59, microsecond=0)

    result = (
        service.events()
        .list(
            calendarId="primary",
            timeMin=start_of_day.isoformat(),
            timeMax=end_of_day.isoformat(),
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )

    events = []
    for item in result.get("items", []):
        start = item["start"].get("dateTime", item["start"].get("date", ""))
        end = item["end"].get("dateTime", item["end"].get("date", ""))
        events.append(
            {
                "summary": item.get("summary", "(No title)"),
                "start": start,
                "end": end,
                "location": item.get("location", ""),
                "description": item.get("description", ""),
                "attendees": [
                    a.get("email", "") for a in item.get("attendees", [])
                ],
            }
        )

    return events
