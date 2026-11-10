"""One private Dex engine and Worker per test module, running the real Claude Code CLI.

The CLI talks to ``ScriptedMessagesApi`` with a dummy key, a private ``HOME``
and ``CLAUDE_CONFIG_DIR``, and a refused proxy, so no test reads this
machine's Claude settings or reaches the network. Only the Worker process gets
that environment; the application's options factory stays unchanged.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
import pytest_asyncio
from dex_agents import AgentInterrupt, AgentSessionClient, AgentSessionFlow, AgentSnapshot
from dex_agents.testing import EXECUTE_COMPLETED_EVENT, AgentTestStack, wait_for_agent_snapshot

from tests.scripted_agent import (
    SLACK_POSTS_LOG_NAME,
    STATE_DIR_ENVIRONMENT_VARIABLE,
    build_scripted_agent_flow,
)
from tests.scripted_messages_api import ScriptedMessagesApi

PROJECT_DIR = Path(__file__).resolve().parents[1]
WORKER_MODULE = "tests.scripted_agent_worker"
DUMMY_API_KEY = "sk-ant-test-not-a-real-key"
REFUSED_PROXY = "http://127.0.0.1:9"


@dataclass
class AgentHarness:
    stack: AgentTestStack
    flow: AgentSessionFlow
    sessions: AgentSessionClient
    messages_api: ScriptedMessagesApi
    mock_report_dir: Path
    state_dir: Path

    def new_session_id(self, prefix: str = "session-") -> str:
        return f"{prefix}{uuid4().hex[:12]}"

    async def wait_for_turns(self, session_id: str, turn_count: int) -> AgentSnapshot:
        return await wait_for_agent_snapshot(
            self.sessions,
            session_id,
            lambda snapshot: snapshot
            if snapshot.state is not None
            and snapshot.state.turn_count >= turn_count
            and snapshot.state.active_turn_id is None
            else None,
            description=f"{turn_count} finished turn(s)",
        )

    async def wait_for_pending_interrupt(self, session_id: str) -> tuple[AgentInterrupt, str]:
        """Return the pending approval and the turn ID of its tool call."""
        return await wait_for_agent_snapshot(
            self.sessions,
            session_id,
            lambda snapshot: next(
                (
                    (interrupt, tool_call.turn_id)
                    for interrupt in snapshot.pending_interrupts
                    for tool_call in snapshot.tool_calls
                    if tool_call.tool_call_id == interrupt.tool_call_id
                ),
                None,
            ),
            description="a pending approval",
        )

    def connector_calls(self, session_id: str, operation_id: str) -> list[dict[str, Any]]:
        """Return the connector mock's report rows for one session and operation."""
        report = self.mock_report_dir / "connector-calls.json"
        if not report.exists():
            return []
        rows = json.loads(report.read_text())["calls"]
        return [
            row
            for row in rows
            if row.get("flowId") == session_id and row["operation"] == operation_id
        ]

    def slack_api_posts(self) -> list[str]:
        """Return the client_msg_id of every chat.postMessage the Slack client sent."""
        posts_log = self.state_dir / SLACK_POSTS_LOG_NAME
        return posts_log.read_text().split() if posts_log.exists() else []

    async def executed_steps(self, session_id: str) -> list[tuple[str, int]]:
        history = await self.stack.read_step_history(session_id)
        return [
            (entry.step_type, entry.final_attempt)
            for entry in history
            if entry.event_type == EXECUTE_COMPLETED_EVENT
        ]


@pytest.fixture(scope="module")
def messages_api() -> Iterator[ScriptedMessagesApi]:
    """Start the scripted Messages API and hide this machine's Claude settings from Workers."""
    hidden = {
        name: os.environ.pop(name)
        for name in list(os.environ)
        if name.startswith(("CLAUDE", "ANTHROPIC")) or name == "AI_AGENT"
    }
    os.environ.setdefault("DEXCLI", shutil.which("dexcli") or "dexcli")
    api = ScriptedMessagesApi()
    api.start()
    try:
        yield api
    finally:
        api.stop()
        os.environ.update(hidden)


@pytest_asyncio.fixture(scope="module")
async def harness(
    tmp_path_factory: pytest.TempPathFactory, messages_api: ScriptedMessagesApi
) -> AsyncIterator[AgentHarness]:
    state_dir = tmp_path_factory.mktemp("agent")
    claude_home = state_dir / "home"
    (claude_home / ".claude").mkdir(parents=True)
    mock_report_dir = state_dir / "connector-mock-report"
    mock_report_dir.mkdir()
    worker_env = {
        "HOME": str(claude_home),
        "CLAUDE_CONFIG_DIR": str(claude_home / ".claude"),
        "ANTHROPIC_API_KEY": DUMMY_API_KEY,
        "ANTHROPIC_BASE_URL": messages_api.base_url,
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_ERROR_REPORTING": "1",
        "HTTPS_PROXY": REFUSED_PROXY,
        "HTTP_PROXY": REFUSED_PROXY,
        "NO_PROXY": "127.0.0.1,localhost",
        "CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK": "1",
        "DEX_CONNECTOR_MOCK_REPORT_DIR": str(mock_report_dir),
        STATE_DIR_ENVIRONMENT_VARIABLE: str(state_dir),
    }
    flow = build_scripted_agent_flow()
    async with AgentTestStack(
        state_dir, [flow], WORKER_MODULE, worker_cwd=PROJECT_DIR, worker_env=worker_env
    ) as stack:
        await stack.start_worker()
        yield AgentHarness(
            stack, flow, stack.sessions(flow), messages_api, mock_report_dir, state_dir
        )
