class SDKAgent:
    """A basic SDK agent for executing tasks."""

    def __init__(self, name: str):
        self.name = name

    def execute(self, task: str) -> None:
        """Execute a given task by printing it.

        Args:
            task: Description of the task to execute.
        """
        print(f"{self.name} executing task: {task}")

if __name__ == "__main__":
    agent = SDKAgent(name="CLI")
    agent.execute("Hello World")
