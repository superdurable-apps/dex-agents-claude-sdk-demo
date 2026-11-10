"""The agent under test: real connector tools over the connectors' own mocks.

The Worker child and the test process both build this Flow. Scenarios are
scripted per session ID prefix with the connector mock's ``for_flow``, because
the mock lives in the Worker child.

``slackapi_post_thread_reply`` runs the real Slack client against a scripted
HTTP transport instead. Its single-dispatch fence needs the session tool Step's
heartbeat checkpoints, which ``slackmock`` never uses. The transport answers
the first ``chat.postMessage`` of each ``client_msg_id`` with 503 and later
ones with success, and logs every ``client_msg_id`` to ``slack-posts.log``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
from dex_agents import AgentSessionFlow
from dex_connectors import slack
from dex_connectors.sdk import (
    ConnectionRef,
    Failure,
    FailureKind,
    SecretString,
    StaticCredentialProvider,
)
from dex_connectors.slack import slackmock

from claude_connectors_demo.agent import build_agent_flow
from claude_connectors_demo.connections import CONNECTION_NAME, ENABLED_OPERATIONS
from claude_connectors_demo.connector_tools import ConnectorBinding

MODEL = "claude-sonnet-5-5"
RETRY_SESSION_PREFIX = "retry-"
PROVIDER_REJECTED_SESSION_PREFIX = "rejected-branch-"
UNKNOWN_OUTCOME_SESSION_PREFIX = "unknown-"
READ_REJECTED_SESSION_PREFIX = "read-rejected-"
STATE_DIR_ENVIRONMENT_VARIABLE = "DEMO_TEST_STATE_DIR"
SLACK_POSTS_LOG_NAME = "slack-posts.log"


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


def build_scripted_slack_api_connection() -> slack.Connection:
    reference = ConnectionRef("slack", CONNECTION_NAME)
    empty = SecretString("")
    credentials = slack.Credentials(
        "", empty, SecretString("xoxb-test"), empty, SecretString("xoxp-test"), empty, empty
    )
    client = slack.Client(
        slack.Config(),
        StaticCredentialProvider({reference: credentials}),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(answer_slack_request)),
    )
    return slack.new_connection(client, reference)


def answer_slack_request(request: httpx.Request) -> httpx.Response:
    payload = json.loads(request.content or b"{}")
    client_msg_id = str(payload.get("client_msg_id", ""))
    posts_log = Path(os.environ[STATE_DIR_ENVIRONMENT_VARIABLE]) / SLACK_POSTS_LOG_NAME
    earlier_posts = posts_log.read_text().split() if posts_log.exists() else []
    with posts_log.open("a") as log:
        log.write(client_msg_id + "\n")
    if client_msg_id not in earlier_posts:
        return httpx.Response(503, json={"ok": False, "error": "service_unavailable"})
    message = {
        "type": "message",
        "ts": "1710000099.000100",
        "thread_ts": payload.get("thread_ts", ""),
        "user": "U0BOT123456",
        "text": payload.get("text", ""),
    }
    return httpx.Response(
        200,
        json={
            "ok": True,
            "channel": payload.get("channel"),
            "ts": message["ts"],
            "message": message,
        },
    )


def build_scripted_agent_flow() -> AgentSessionFlow:
    bindings = [
        ConnectorBinding(
            tool_prefix="slack",
            package="dex_connectors.slack",
            connection=build_scripted_slack_mock().connection(),
            enabled_operation_ids=ENABLED_OPERATIONS["slack"],
        ),
        ConnectorBinding(
            tool_prefix="slackapi",
            package="dex_connectors.slack",
            connection=build_scripted_slack_api_connection(),
            enabled_operation_ids=("postThreadReply",),
        ),
    ]
    return build_agent_flow(bindings, model=MODEL, max_budget_usd=1.0)
