"""A write reviewed as retry-safe: the real Slack client's fence across Step attempts.

No connector in this demo declares retry: safe, so this module binds Slack
postThreadReply under a test manifest that does.
"""

from __future__ import annotations

import json

from claude_connectors_demo.connector_tools import connector_call_id
from tests.conftest import AgentHarness
from tests.test_connector_tools import THREAD

EXTRA_TOOL_PREFIXES = ("slackapi",)


async def test_real_slack_client_resends_only_after_its_fence_checkpoint(
    harness: AgentHarness,
) -> None:
    """The Slack fence's canResend marker must survive into the next Step attempt."""
    session_id = harness.new_session_id("fence-")
    prompt = "call slackapi_post_thread_reply " + json.dumps({**THREAD, "text": "Fenced reply."})
    await harness.sessions.start_session(session_id, prompt)
    interrupt, turn_id = await harness.wait_for_pending_interrupt(session_id)
    assert await harness.sessions.resolve_interrupt(
        session_id, interrupt.interrupt_id, approved=True
    )

    snapshot = await harness.wait_for_turns(session_id, 1)

    answer = snapshot.messages[-1].text or ""
    output = json.loads(answer.removeprefix("result: "))
    assert output["branch"] == "sent", answer
    assert output["value"]["message"]["text"] == "Fenced reply."
    expected_call_id = connector_call_id(f"{session_id}/{turn_id}/{interrupt.tool_call_id}")
    assert harness.slack_api_posts().count(expected_call_id) == 2
    executed = await harness.executed_steps(session_id)
    assert ("CallTool", 2) in executed
    assert "CallSingleAttemptTool" not in [step for step, _ in executed]
