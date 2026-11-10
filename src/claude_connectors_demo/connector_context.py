"""The Dex Step context that connector operations read, rebuilt for agent tool calls.

Connector operations expect ``Call.context`` to be the live ``dex.AsyncContext``
of their own connector Step. An agent tool call runs inside an agent session
Step instead, and the adapter hands the tool handler only a
``DeferredToolExecution``. ``ToolCallContext`` offers the part of the context
that connectors use, backed by that execution:

* ``flow_id`` and ``attempt`` come from the session's tool Step.
* Heartbeat checkpoints, such as the single-dispatch ``Marker`` of a Mutation,
  are saved through ``save_heartbeat_checkpoint``, so the next attempt of the
  same tool Step reads them back and never sends a write twice.
* ``run_id`` and ``flow_started_at`` are not available to a tool handler. They
  get values that stay the same for every attempt of one tool call, which is
  what connectors need them for (a stable provider-side identity).
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TypeVar, cast

import dex
from dex_agents import DeferredToolExecution
from dex_agents_claude_agent_sdk import ClaudeAgentOptionsContext

ValueT = TypeVar("ValueT")

# Gmail hashes it into a Message-ID together with the per-call key, so any constant works.
_STABLE_FLOW_STARTED_AT = datetime(1970, 1, 1, tzinfo=UTC)

_running_turn_segment: ContextVar[ClaudeAgentOptionsContext | None] = ContextVar(
    "claude_connectors_demo_running_turn_segment", default=None
)


def remember_turn_segment(segment: ClaudeAgentOptionsContext) -> None:
    """Record the running turn segment for inline tool calls of this ``RunModel`` attempt.

    The options factory calls it. The adapter then starts the Claude Code CLI
    and its in-process MCP server from the same task, so inline tool handlers
    inherit the value.
    """
    _running_turn_segment.set(segment)


@dataclass
class ToolCallContext:
    """The subset of ``dex.AsyncContext`` that connector operations read."""

    flow_id: str
    run_id: str
    attempt: int
    deadline: datetime | None
    flow_started_at: datetime
    _previous_checkpoint: str | None
    _heartbeat: Callable[[], Awaitable[None]]
    _save_checkpoint: Callable[[str], Awaitable[None]] | None

    def has_last_heartbeat_value(self) -> bool:
        """Report whether the previous attempt of this tool call saved a checkpoint."""
        return self._previous_checkpoint is not None

    def get_last_heartbeat_value(self, value_type: type[ValueT]) -> ValueT | None:
        """Decode the previous attempt's checkpoint with the type's ``from_wire``."""
        if self._previous_checkpoint is None:
            return None
        from_wire = getattr(value_type, "from_wire", None)
        if from_wire is None:
            raise TypeError(f"{value_type.__name__} has no from_wire; it cannot be a checkpoint")
        return cast(ValueT, from_wire(json.loads(self._previous_checkpoint)))

    async def heartbeat(self, value: object = ...) -> None:
        """Record liveness, saving ``value`` as this attempt's checkpoint when given."""
        if value is ...:
            await self._heartbeat()
            return
        if self._save_checkpoint is None:
            raise RuntimeError("this tool call cannot save heartbeat checkpoints")
        to_wire = getattr(value, "to_wire", None)
        if to_wire is None:
            raise TypeError(f"{type(value).__name__} has no to_wire; it cannot be a checkpoint")
        await self._save_checkpoint(json.dumps(to_wire(), separators=(",", ":")))

    def is_cancellation_requested(self) -> bool:
        """Report no cancellation; the session cancels a tool Step by cancelling its task."""
        return False


def deferred_tool_call_context(
    execution: DeferredToolExecution, execute_timeout: timedelta
) -> dex.AsyncContext:
    """Build the connector context for a call that runs in its own session tool Step.

    Args:
        execution: The adapter's record of the running tool Step attempt.
        execute_timeout: The connector operation's own Execute timeout. It sets
            the attempt deadline that connectors budget their provider call by.

    Returns:
        A context to put in ``Call.context``.
    """
    context = ToolCallContext(
        flow_id=execution.flow_id,
        run_id=execution.flow_id,
        attempt=execution.attempt,
        deadline=datetime.now(UTC) + execute_timeout,
        flow_started_at=_STABLE_FLOW_STARTED_AT,
        _previous_checkpoint=execution.heartbeat_checkpoint,
        _heartbeat=execution.heartbeat,
        _save_checkpoint=execution.save_heartbeat_checkpoint,
    )
    return cast(dex.AsyncContext, context)


def inline_tool_call_context(execute_timeout: timedelta) -> dex.AsyncContext:
    """Build the connector context for a read that runs inside the ``RunModel`` Step.

    Args:
        execute_timeout: The connector operation's own Execute timeout.

    Returns:
        A context to put in ``Call.context``.

    Raises:
        RuntimeError: If no turn segment is running, so the session is unknown.
    """
    segment = _running_turn_segment.get()
    if segment is None:
        raise RuntimeError("an inline connector call ran outside a turn segment")

    async def no_heartbeat() -> None:
        return None

    context = ToolCallContext(
        flow_id=segment.flow_id,
        run_id=segment.flow_id,
        attempt=segment.attempt,
        deadline=datetime.now(UTC) + execute_timeout,
        flow_started_at=_STABLE_FLOW_STARTED_AT,
        _previous_checkpoint=None,
        _heartbeat=no_heartbeat,
        _save_checkpoint=None,
    )
    return cast(dex.AsyncContext, context)
