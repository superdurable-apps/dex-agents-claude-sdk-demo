"""A write that took effect but whose result run_mutation turns into defect."""

from __future__ import annotations

import json

from claude_connectors_demo.connector_tools import connector_call_id
from tests.conftest import AgentHarness
from tests.test_connector_tools import THREAD

EXTRA_TOOL_PREFIXES = ("slackbroken",)


async def test_mutation_defect_after_the_write_is_an_unknown_outcome(
    harness: AgentHarness,
) -> None:
    """Slack's manifest calls defect rejected, but run_mutation can select it after a write."""
    session_id = harness.new_session_id("defect-")
    prompt = "call slackbroken_post_thread_reply " + json.dumps({**THREAD, "text": "Broken."})
    await harness.sessions.start_session(session_id, prompt)
    interrupt, turn_id = await harness.wait_for_pending_interrupt(session_id)
    assert await harness.sessions.resolve_interrupt(
        session_id, interrupt.interrupt_id, approved=True
    )

    snapshot = await harness.wait_for_turns(session_id, 1)

    answer = snapshot.messages[-1].text or ""
    assert answer.startswith("error result: "), answer
    assert "The outcome of slackbroken_post_thread_reply is unknown" in answer
    assert "returned 'defect'" in answer
    assert "Nothing was changed" not in answer
    expected_call_id = connector_call_id(f"{session_id}/{turn_id}/{interrupt.tool_call_id}")
    assert harness.broken_slack_writes().count(expected_call_id) == 1
