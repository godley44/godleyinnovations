"""Morning summary — fetches calendar + Gmail data and generates a prioritized briefing."""

import json
import os
from datetime import datetime

import anthropic
from dotenv import load_dotenv

from .calendar_client import get_todays_events
from .gmail_client import get_important_emails

load_dotenv()

_MODEL = "claude-sonnet-4-6"

_SYSTEM_PROMPT = """You are a personal productivity assistant. Every morning you prepare a concise, \
actionable briefing for the user based on their Google Calendar events and unread emails.

Your summary must:
1. Open with a one-line greeting that includes today's date.
2. List today's calendar events in chronological order with times and locations.
3. Highlight the top 3–5 emails that need attention, with a one-sentence action for each.
4. Close with a ranked "Top Priorities" section (numbered list, max 5 items) that combines \
insights from the calendar and inbox.

Be concise. Use plain text with minimal markdown (headers with ## are fine, bullet points are fine). \
Avoid filler words."""


def generate_morning_summary() -> str:
    """Fetch data from Google APIs, call Claude, and return the formatted summary."""
    today = datetime.now().strftime("%A, %B %-d, %Y")

    print(f"[MorningSummary] Fetching calendar events for {today}...")
    events = get_todays_events()

    print("[MorningSummary] Scanning Gmail inbox...")
    emails = get_important_emails()

    user_message = _build_user_message(today, events, emails)

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    response = client.messages.create(
        model=_MODEL,
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": _SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_message}],
    )

    return response.content[0].text


def _build_user_message(today: str, events: list, emails: list) -> str:
    events_json = json.dumps(events, indent=2) if events else "No events today."
    emails_json = json.dumps(emails, indent=2) if emails else "No unread emails."

    return (
        f"Today is {today}.\n\n"
        f"## Calendar Events\n{events_json}\n\n"
        f"## Unread Emails (last 24 hours)\n{emails_json}\n\n"
        "Please generate my morning briefing."
    )


def print_morning_summary() -> None:
    """Generate and print the morning summary to the console."""
    separator = "=" * 60
    print(f"\n{separator}")
    print("  MORNING SUMMARY")
    print(separator)
    summary = generate_morning_summary()
    print(summary)
    print(f"{separator}\n")
