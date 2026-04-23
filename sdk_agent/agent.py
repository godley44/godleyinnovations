import os
import anthropic

ANTHROPIC_BASE_URL = "https://api.anthropic.com"


class SDKAgent:
    """Agent that calls Claude via the Anthropic API."""

    def __init__(self, name: str = "SDKAgent"):
        self.name = name
        self._client = anthropic.Anthropic(
            api_key=os.environ.get("ANTHROPIC_API_KEY"),
            base_url=ANTHROPIC_BASE_URL,
        )

    def execute(self, task: str) -> str:
        """Send a task to Claude and return the text response."""
        message = self._client.messages.create(
            model="claude-opus-4-7",
            max_tokens=1024,
            thinking={"type": "adaptive"},
            messages=[{"role": "user", "content": task}],
        )
        text = next(
            (block.text for block in message.content if block.type == "text"), ""
        )
        return text
