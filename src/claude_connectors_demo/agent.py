"""The durable agent session: Claude Agent SDK options plus connector tools."""

from __future__ import annotations

from collections.abc import Sequence

from claude_agent_sdk import ClaudeAgentOptions
from dex_agents import AgentSessionFlow
from dex_agents_claude_agent_sdk import ClaudeAgentOptionsContext, claude_agent_session_flow

from claude_connectors_demo.connector_context import remember_turn_segment
from claude_connectors_demo.connector_tools import ConnectorBinding, build_connector_toolset

FLOW_TYPE = "ConnectorsAgent"
ACTION_PERMISSION = "connectors-agent.operate"

SYSTEM_PROMPT = """\
You are an assistant that works with the user's apps through connector tools:
Hacker News, Slack, Gmail, YouTube, Reddit, and Spotify. Only the tools you are
given are available; say so when a request needs one you do not have.

Read tools run at once. Tools that change something, such as posting to Slack
or sending email, wait until a person approves the call. If a call is rejected,
do not try it again unless the user asks.

When a tool result says that its outcome is unknown, the change may or may not
have happened. Never call that tool again for the same request. Tell the user
what you tried and ask them to check.

Keep answers short and factual, and quote the data the tools return.
"""


def build_agent_flow(
    bindings: Sequence[ConnectorBinding], *, model: str, max_budget_usd: float
) -> AgentSessionFlow:
    """Build the session Flow whose tools are the bound connector operations.

    Args:
        bindings: Connectors and the operations to offer as tools.
        model: Claude model ID for every turn.
        max_budget_usd: Spending cap of one turn segment.

    Returns:
        The ``ConnectorsAgent`` session Flow for the Registry and the Client.
    """
    toolset = build_connector_toolset(bindings)

    def build_options(segment: ClaudeAgentOptionsContext) -> ClaudeAgentOptions:
        remember_turn_segment(segment)
        return ClaudeAgentOptions(
            model=model,
            system_prompt=SYSTEM_PROMPT,
            # No Claude Code built-in tools: the agent acts only through connector tools.
            tools=[],
            setting_sources=[],
            max_budget_usd=max_budget_usd,
        )

    return claude_agent_session_flow(
        build_options,
        toolset.tools,
        flow_type=FLOW_TYPE,
        tool_policies=toolset.policies,
    )
