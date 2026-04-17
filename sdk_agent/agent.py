from .morning_summary import print_morning_summary


class SDKAgent:
    """A basic SDK agent for executing tasks."""

    def __init__(self, name: str):
        self.name = name

    def execute(self, task: str) -> None:
        """Execute a given task.

        Recognized tasks:
          - "morning_summary": fetch calendar + Gmail and print a prioritized briefing.
          - anything else: print the task name to stdout.
        """
        if task == "morning_summary":
            print_morning_summary()
        else:
            print(f"{self.name} executing task: {task}")


if __name__ == "__main__":
    agent = SDKAgent(name="CLI")
    agent.execute("Hello World")
