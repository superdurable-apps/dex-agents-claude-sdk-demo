"""A scripted stand-in for the Anthropic Messages API, so tests run the real Claude Code CLI.

``ScriptedMessagesApi`` serves ``POST /v1/messages`` on 127.0.0.1 and records
every request. The scripted model reads the latest user prompt:

* ``say <text>`` answers ``<text>``.
* ``call <tool> <json>`` calls the tool whose name is ``<tool>`` or ends with
  ``__<tool>``. Once the tool result arrives it answers
  ``result: <tool result text>``, prefixed with ``error`` when the result is an
  error.
"""

from __future__ import annotations

import json
import threading
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

USAGE = {"input_tokens": 10, "output_tokens": 5}


@dataclass
class RecordedRequest:
    path: str
    api_key: str | None
    body: dict[str, Any]


@dataclass
class ScriptedMessagesApi:
    requests: list[RecordedRequest] = field(default_factory=list)
    _server: ThreadingHTTPServer | None = None
    _thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        if self._server is None:
            raise RuntimeError("start the scripted Messages API first")
        host, port = self._server.server_address[:2]
        return f"http://{host!s}:{port}"

    def start(self) -> None:
        api = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                api.requests.append(RecordedRequest(self.path, self.headers.get("x-api-key"), body))
                if not self.path.split("?", 1)[0].endswith("/v1/messages"):
                    self._send_json(404, {"type": "error", "error": {"type": "not_found_error"}})
                    return
                message = scripted_reply(body)
                if body.get("stream"):
                    self._send_events(message)
                else:
                    self._send_json(200, message)

            def do_GET(self) -> None:
                api.requests.append(RecordedRequest(self.path, self.headers.get("x-api-key"), {}))
                self._send_json(404, {"type": "error", "error": {"type": "not_found_error"}})

            def log_message(self, format: str, *args: Any) -> None:
                return

            def _send_json(self, status: int, payload: dict[str, Any]) -> None:
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _send_events(self, message: dict[str, Any]) -> None:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for event in _stream_events(message):
                    self.wfile.write(
                        f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode()
                    )
                    self.wfile.flush()

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def model_requests(self) -> list[dict[str, Any]]:
        return [
            request.body for request in self.requests if request.path.startswith("/v1/messages")
        ]


def scripted_reply(body: dict[str, Any]) -> dict[str, Any]:
    messages = body.get("messages") or []
    prompt_index, prompt = _latest_prompt(messages)
    tool_results = [
        block
        for message in messages[prompt_index + 1 :]
        if isinstance(message.get("content"), list)
        for block in message["content"]
        if isinstance(block, dict) and block.get("type") == "tool_result"
    ]
    content: list[dict[str, Any]]
    if tool_results:
        last = tool_results[-1]
        prefix = "error " if last.get("is_error") else ""
        content = [{"type": "text", "text": f"{prefix}result: {_block_text(last.get('content'))}"}]
    elif prompt.startswith("call "):
        _, tool_name, tool_input = prompt.split(" ", 2)
        content = [
            {
                "type": "tool_use",
                "id": f"toolu_{uuid.uuid4().hex[:20]}",
                "name": _resolve_tool_name(tool_name, body.get("tools") or []),
                "input": json.loads(tool_input),
            }
        ]
    elif prompt.startswith("say "):
        content = [{"type": "text", "text": prompt.removeprefix("say ")}]
    else:
        content = [{"type": "text", "text": f"unknown command: {prompt[:80]}"}]
    is_tool_use = content[0]["type"] == "tool_use"
    return {
        "id": f"msg_{uuid.uuid4().hex[:20]}",
        "type": "message",
        "role": "assistant",
        "model": str(body.get("model") or "scripted"),
        "content": content,
        "stop_reason": "tool_use" if is_tool_use else "end_turn",
        "stop_sequence": None,
        "usage": USAGE,
    }


def _stream_events(message: dict[str, Any]) -> Iterator[dict[str, Any]]:
    yield {"type": "message_start", "message": {**message, "content": [], "stop_reason": None}}
    for index, block in enumerate(message["content"]):
        if block["type"] == "text":
            yield {
                "type": "content_block_start",
                "index": index,
                "content_block": {"type": "text", "text": ""},
            }
            delta = {"type": "text_delta", "text": block["text"]}
        else:
            yield {
                "type": "content_block_start",
                "index": index,
                "content_block": {**block, "input": {}},
            }
            delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
        yield {"type": "content_block_delta", "index": index, "delta": delta}
        yield {"type": "content_block_stop", "index": index}
    yield {
        "type": "message_delta",
        "delta": {"stop_reason": message["stop_reason"], "stop_sequence": None},
        "usage": {"output_tokens": USAGE["output_tokens"]},
    }
    yield {"type": "message_stop"}


def _latest_prompt(messages: list[dict[str, Any]]) -> tuple[int, str]:
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return index, content.strip()
        if not isinstance(content, list):
            continue
        if any(isinstance(block, dict) and block.get("type") == "tool_result" for block in content):
            continue
        texts = [
            str(block.get("text", "")).strip()
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        # Claude Code adds <system-reminder> blocks; the command is the last plain text.
        commands = [text for text in texts if text and not text.startswith("<")]
        if commands:
            return index, commands[-1]
    return -1, ""


def _resolve_tool_name(tool_name: str, tools: list[dict[str, Any]]) -> str:
    for tool in tools:
        name = str(tool.get("name"))
        if name == tool_name or name.endswith(f"__{tool_name}"):
            return name
    return tool_name


def _block_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(block.get("text", "")) for block in content if isinstance(block, dict))
    return ""
