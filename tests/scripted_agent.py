"""The agent under test: real connector tools over the connectors' own mocks.

The Worker child and the test process both build this Flow. Scenarios are
scripted per session ID prefix with the connector mock's ``for_flow``, because
the mock lives in the Worker child.
"""

from __future__ import annotations

from dex_agents import AgentSessionFlow
from dex_connectors.sdk import Failure, FailureKind
from dex_connectors.slack import slackmock

from claude_connectors_demo.agent import build_agent_flow
from claude_connectors_demo.connections import CONNECTION_NAME, ENABLED_OPERATIONS
from claude_connectors_demo.connector_tools import ConnectorBinding

MODEL = "claude-sonnet-5-5"
RETRY_SESSION_PREFIX = "retry-"
PROVIDER_REJECTED_SESSION_PREFIX = "rejected-branch-"
UNKNOWN_OUTCOME_SESSION_PREFIX = "unknown-"
READ_REJECTED_SESSION_PREFIX = "read-rejected-"


def build_scripted_slack_mock() -> slackmock.Mock:
    mock = slackmock.Mock(CONNECTION_NAME)
    mock.post_thread_reply_script.for_flow(RETRY_SESSION_PREFIX).respond(
        slackmock.post_thread_reply_retry(
            Failure(
                FailureKind.RATE_LIMIT, "slack", "postThreadReply", "Slack rate limited the reply"
            )
        ),
        slackmock.post_thread_reply_reply_sent(),
    )
    mock.post_thread_reply_script.for_flow(PROVIDER_REJECTED_SESSION_PREFIX).respond(
        slackmock.post_thread_reply_thread_rejected()
    )
    mock.post_thread_reply_script.for_flow(UNKNOWN_OUTCOME_SESSION_PREFIX).respond(
        slackmock.post_thread_reply_reply_outcome_unknown()
    )
    mock.list_thread_messages_script.for_flow(READ_REJECTED_SESSION_PREFIX).respond(
        slackmock.list_thread_messages_read_rejected()
    )
    return mock


def build_scripted_agent_flow() -> AgentSessionFlow:
    binding = ConnectorBinding(
        tool_prefix="slack",
        package="dex_connectors.slack",
        connection=build_scripted_slack_mock().connection(),
        enabled_operation_ids=ENABLED_OPERATIONS["slack"],
    )
    return build_agent_flow([binding], model=MODEL, max_budget_usd=1.0)
