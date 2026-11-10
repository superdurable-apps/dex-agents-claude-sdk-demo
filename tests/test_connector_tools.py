"""Connector tools in a durable agent session, end to end on a private Dex engine.

Every test runs the real Claude Code CLI against the scripted Messages API, and
real connector operations against the Slack connector's own mock.
"""

from __future__ import annotations

import json

from dex_connectors.slack import Message

from claude_connectors_demo.connector_tools import (
    MAX_TOOL_OUTPUT_CHARACTERS,
    _encode_output,
    connector_call_id,
)
from tests.conftest import DUMMY_API_KEY, AgentHarness
from tests.scripted_agent import (
    PROVIDER_REJECTED_SESSION_PREFIX,
    READ_REJECTED_SESSION_PREFIX,
    READ_RETRY_SESSION_PREFIX,
    READ_UNAVAILABLE_SESSION_PREFIX,
    RETRY_SESSION_PREFIX,
    UNKNOWN_OUTCOME_SESSION_PREFIX,
)

THREAD = {"channelId": "C0123456789", "threadTimestamp": "1710000000.000100"}
READ_THREAD_PROMPT = "call slack_list_thread_messages " + json.dumps({**THREAD, "pageSize": 2})
POST_REPLY_PROMPT = "call slack_post_thread_reply " + json.dumps(
    {**THREAD, "text": "Processing complete."}
)


async def test_query_tool_runs_inline_without_approval(harness: AgentHarness) -> None:
    session_id = harness.new_session_id("query-")
    await harness.sessions.start_session(session_id, READ_THREAD_PROMPT)

    snapshot = await harness.wait_for_turns(session_id, 1)

    answer = snapshot.messages[-1].text or ""
    assert answer.startswith("result: "), answer
    output = json.loads(answer.removeprefix("result: "))
    assert output["branch"] == "read"
    assert output["value"]["messages"][0]["text"] == "Request approval for order 1042."
    assert len(harness.connector_calls(session_id, "listThreadMessages")) == 1
    executed = [step for step, _ in await harness.executed_steps(session_id)]
    assert "AwaitToolApproval" not in executed
    assert "CallTool" not in executed
    offered_tools = {
        tool["name"] for tool in harness.messages_api.model_requests()[0].get("tools") or []
    }
    assert {
        "mcp__tools__slack_list_thread_messages",
        "mcp__tools__slack_get_thread_reply",
        "mcp__tools__slack_post_channel_message",
        "mcp__tools__slack_post_thread_reply",
    } <= offered_tools
    assert not offered_tools & {"Bash", "Read", "Write", "WebFetch"}
    _assert_only_the_scripted_api_was_reached(harness)


async def test_query_failure_branch_reaches_the_model_as_an_error(harness: AgentHarness) -> None:
    session_id = harness.new_session_id(READ_REJECTED_SESSION_PREFIX)
    await harness.sessions.start_session(session_id, READ_THREAD_PROMPT)

    snapshot = await harness.wait_for_turns(session_id, 1)

    answer = snapshot.messages[-1].text or ""
    assert answer.startswith("error result: "), answer
    assert "returned 'providerRejected'" in answer
    assert "the app is not in the channel" in answer


async def test_mutation_waits_for_approval_then_runs_once_with_a_stable_call_id(
    harness: AgentHarness,
) -> None:
    session_id = harness.new_session_id("post-")
    await harness.sessions.start_session(session_id, POST_REPLY_PROMPT)

    interrupt, turn_id = await harness.wait_for_pending_interrupt(session_id)
    assert interrupt.tool_name == "slack_post_thread_reply"
    assert json.loads(interrupt.arguments)["text"] == "Processing complete."
    assert harness.connector_calls(session_id, "postThreadReply") == []

    assert await harness.sessions.resolve_interrupt(
        session_id, interrupt.interrupt_id, approved=True
    )
    snapshot = await harness.wait_for_turns(session_id, 1)

    answer = snapshot.messages[-1].text or ""
    assert json.loads(answer.removeprefix("result: "))["branch"] == "sent"
    calls = harness.connector_calls(session_id, "postThreadReply")
    expected_call_id = connector_call_id(f"{session_id}/{turn_id}/{interrupt.tool_call_id}")
    assert [call["callId"] for call in calls] == [expected_call_id]
    assert ("AwaitToolApproval", 1) in await harness.executed_steps(session_id)
    assert ("CallTool", 1) in await harness.executed_steps(session_id)


async def test_connector_retry_retries_the_step_with_the_same_call_id(
    harness: AgentHarness,
) -> None:
    session_id = harness.new_session_id(RETRY_SESSION_PREFIX)
    await harness.sessions.start_session(session_id, POST_REPLY_PROMPT)
    interrupt, turn_id = await harness.wait_for_pending_interrupt(session_id)
    assert await harness.sessions.resolve_interrupt(
        session_id, interrupt.interrupt_id, approved=True
    )

    snapshot = await harness.wait_for_turns(session_id, 1)

    assert (
        json.loads((snapshot.messages[-1].text or "").removeprefix("result: "))["branch"] == "sent"
    )
    calls = harness.connector_calls(session_id, "postThreadReply")
    expected_call_id = connector_call_id(f"{session_id}/{turn_id}/{interrupt.tool_call_id}")
    assert [(call["callId"], call.get("retry", False)) for call in calls] == [
        (expected_call_id, True),
        (expected_call_id, False),
    ]
    assert ("CallTool", 2) in await harness.executed_steps(session_id)


async def test_rejected_mutation_never_runs(harness: AgentHarness) -> None:
    session_id = harness.new_session_id("reject-")
    await harness.sessions.start_session(session_id, POST_REPLY_PROMPT)
    interrupt, _ = await harness.wait_for_pending_interrupt(session_id)

    assert await harness.sessions.resolve_interrupt(
        session_id,
        interrupt.interrupt_id,
        approved=False,
        rejection_message="Do not post in that thread.",
    )
    snapshot = await harness.wait_for_turns(session_id, 1)

    assert "Do not post in that thread." in (snapshot.messages[-1].text or "")
    assert harness.connector_calls(session_id, "postThreadReply") == []
    assert "CallTool" not in [step for step, _ in await harness.executed_steps(session_id)]


async def test_provider_rejection_reaches_the_model_as_a_failure(harness: AgentHarness) -> None:
    session_id = harness.new_session_id(PROVIDER_REJECTED_SESSION_PREFIX)
    await harness.sessions.start_session(session_id, POST_REPLY_PROMPT)
    interrupt, _ = await harness.wait_for_pending_interrupt(session_id)
    assert await harness.sessions.resolve_interrupt(
        session_id, interrupt.interrupt_id, approved=True
    )

    snapshot = await harness.wait_for_turns(session_id, 1)

    answer = snapshot.messages[-1].text or ""
    assert answer.startswith("error result: "), answer
    assert "returned 'providerRejected'" in answer
    assert "Nothing was changed." in answer
    assert len(harness.connector_calls(session_id, "postThreadReply")) == 1


async def test_uncertain_mutation_says_the_outcome_is_unknown(harness: AgentHarness) -> None:
    session_id = harness.new_session_id(UNKNOWN_OUTCOME_SESSION_PREFIX)
    await harness.sessions.start_session(session_id, POST_REPLY_PROMPT)
    interrupt, _ = await harness.wait_for_pending_interrupt(session_id)
    assert await harness.sessions.resolve_interrupt(
        session_id, interrupt.interrupt_id, approved=True
    )

    snapshot = await harness.wait_for_turns(session_id, 1)

    answer = snapshot.messages[-1].text or ""
    assert answer.startswith("error result: "), answer
    assert "The outcome of slack_post_thread_reply is unknown" in answer
    assert "Do not call slack_post_thread_reply again" in answer
    assert len(harness.connector_calls(session_id, "postThreadReply")) == 1


async def test_inline_query_retries_in_place_after_a_connector_retry(
    harness: AgentHarness,
) -> None:
    session_id = harness.new_session_id(READ_RETRY_SESSION_PREFIX)
    await harness.sessions.start_session(session_id, READ_THREAD_PROMPT)

    snapshot = await harness.wait_for_turns(session_id, 1)

    answer = snapshot.messages[-1].text or ""
    assert json.loads(answer.removeprefix("result: "))["branch"] == "read", answer
    calls = harness.connector_calls(session_id, "listThreadMessages")
    assert [call.get("retry", False) for call in calls] == [True, False]
    assert "CallTool" not in [step for step, _ in await harness.executed_steps(session_id)]


async def test_inline_query_reports_a_temporary_failure_after_its_retries(
    harness: AgentHarness,
) -> None:
    session_id = harness.new_session_id(READ_UNAVAILABLE_SESSION_PREFIX)
    await harness.sessions.start_session(session_id, READ_THREAD_PROMPT)

    snapshot = await harness.wait_for_turns(session_id, 1)

    answer = snapshot.messages[-1].text or ""
    assert answer.startswith("error result: "), answer
    assert "temporarily unavailable after 3 attempts" in answer
    assert len(harness.connector_calls(session_id, "listThreadMessages")) == 3


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


def test_long_output_stays_valid_json() -> None:
    long_text = "x" * (MAX_TOOL_OUTPUT_CHARACTERS * 2)

    encoded = _encode_output("found", Message(text=long_text))

    assert len(encoded) <= MAX_TOOL_OUTPUT_CHARACTERS
    document = json.loads(encoded)
    assert document["branch"] == "found"
    assert document["truncated"] is True
    assert document["originalLength"] > MAX_TOOL_OUTPUT_CHARACTERS
    assert document["preview"].startswith('{"branch": "found", "value": {')
    short = json.loads(_encode_output("found", Message(text="short")))
    assert short["value"]["text"] == "short"
    assert "truncated" not in short


def _assert_only_the_scripted_api_was_reached(harness: AgentHarness) -> None:
    requests = harness.messages_api.requests
    assert requests
    assert {request.api_key for request in requests} == {DUMMY_API_KEY}


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
    assert ("CallTool", 2) in await harness.executed_steps(session_id)
