"""Google OAuth2 authentication for Calendar and Gmail APIs."""

import os
from pathlib import Path

from dotenv import load_dotenv
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

load_dotenv()

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
]


def get_credentials() -> Credentials:
    """Return valid Google OAuth2 credentials, prompting for login if needed."""
    token_file = os.getenv("TOKEN_FILE", "credentials/token.json")
    client_secrets = os.getenv(
        "GOOGLE_CLIENT_SECRETS_FILE", "credentials/client_secrets.json"
    )

    creds = None

    if Path(token_file).exists():
        creds = Credentials.from_authorized_user_file(token_file, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not Path(client_secrets).exists():
                raise FileNotFoundError(
                    f"Google client secrets not found at '{client_secrets}'.\n"
                    "Download it from Google Cloud Console → APIs & Services → Credentials."
                )
            flow = InstalledAppFlow.from_client_secrets_file(client_secrets, SCOPES)
            creds = flow.run_local_server(port=0)

        Path(token_file).parent.mkdir(parents=True, exist_ok=True)
        Path(token_file).write_text(creds.to_json())

    return creds
