import os
from flask import Flask, request, jsonify
from sdk_agent.agent import SDKAgent

app = Flask(__name__)


@app.route("/", methods=["GET"])
def health():
    return jsonify({"status": "ok", "message": "Godley Innovations agent server is running."})


@app.route("/execute", methods=["POST"])
def execute():
    data = request.get_json(force=True, silent=True) or {}
    task = data.get("task", "").strip()
    name = data.get("name", "ReplitAgent").strip()

    if not task:
        return jsonify({"error": "Missing 'task' field in request body."}), 400

    agent = SDKAgent(name=name)
    output = agent.execute(task)

    return jsonify({"agent": name, "task": task, "output": output})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
