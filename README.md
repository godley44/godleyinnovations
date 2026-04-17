# godleyinnovations

Create and execute task-based operations with an AI-powered SDK agent.

## SDK Agent

```python
from sdk_agent import SDKAgent

agent = SDKAgent(name="MyAgent")
agent.execute("Sample Task")
```

## Morning Summary Feature

Every morning at 8:00 AM the agent checks your Google Calendar and Gmail inbox, then uses Claude AI to deliver a prioritized briefing directly in the app.

### What it does

- Reads today's Google Calendar events
- Scans your Gmail inbox for unread messages from the last 24 hours
- Sends the data to Claude, which produces a concise briefing with your top priorities

### Setup

#### 1. Install dependencies

```bash
pip install -r requirements.txt
```

#### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env and fill in your ANTHROPIC_API_KEY
```

#### 3. Create a Google Cloud project and enable APIs

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Enable the **Google Calendar API** and **Gmail API**.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
5. Choose **Desktop app**, download the JSON file, and save it as `credentials/client_secrets.json`.

#### 4. Authorize the app (first run only)

```bash
python morning_summary_runner.py --now
```

A browser window will open for Google OAuth. After approval the token is saved to `credentials/token.json` and reused on subsequent runs.

#### 5. Run on a schedule

```bash
# Keep running in the background — fires at 08:00 every day
python morning_summary_runner.py
```

Or trigger immediately:

```bash
python morning_summary_runner.py --now
```

Or via the SDK agent:

```python
from sdk_agent import SDKAgent

agent = SDKAgent(name="Morning")
agent.execute("morning_summary")
```

### Automatic start (optional)

To have the summary run automatically at login, add a cron entry:

```bash
# Edit crontab
crontab -e

# Add this line (adjust the path):
0 8 * * * /usr/bin/python3 /path/to/godleyinnovations/morning_summary_runner.py --now >> /tmp/morning_summary.log 2>&1
```
