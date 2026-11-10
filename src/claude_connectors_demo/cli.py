"""Command line client: start sessions, send messages, and approve or reject tool calls.

Examples::

    uv run connectors-agent start demo-1 "What is the top Hacker News story?" --wait
    uv run connectors-agent show demo-1
    uv run connectors-agent approve demo-1 <interrupt-id> --wait
    uv run connectors-agent reject demo-1 <interrupt-id> --reason "Not now"
    uv run connectors-agent graph --out definitions/connectors-agent.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from pathlib import Path

from dex import AsyncClient, BlobCacheConfig, ClientOptions, Registry, open_blob_cache
from dex_agents import AgentSessionClient, AgentSnapshot, render_session_flow_graph

from claude_connectors_demo.agent import ACTION_PERMISSION, FLOW_TYPE, build_agent_flow
from claude_connectors_demo.settings import DemoSettings

BLOB_CACHE_BYTES = 64 * 1024 * 1024
WAIT_POLL_SECONDS = 1.0
DEFAULT_WAIT_TIMEOUT_SECONDS = 300.0


def main(arguments: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    options = parser.parse_args(arguments)
    if options.command == "graph":
        return _write_graph(options.out)
    return asyncio.run(_run(options))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="connectors-agent", description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)

    start = commands.add_parser("start", help="start a session, optionally with a first message")
    start.add_argument("session_id")
    start.add_argument("message", nargs="?")
    _add_wait_flags(start)

    send = commands.add_parser("send", help="send a user message to a running session")
    send.add_argument("session_id")
    send.add_argument("message")
    _add_wait_flags(send)

    show = commands.add_parser(
        "show", help="print the session state, messages, and pending approvals"
    )
    show.add_argument("session_id")
    show.add_argument("--messages", type=int, default=10, help="how many recent messages to print")

    pending = commands.add_parser("pending", help="list pending approvals")
    pending.add_argument("session_id")

    approve = commands.add_parser("approve", help="approve a pending tool call")
    approve.add_argument("session_id")
    approve.add_argument("interrupt_id")
    _add_wait_flags(approve)

    reject = commands.add_parser("reject", help="reject a pending tool call")
    reject.add_argument("session_id")
    reject.add_argument("interrupt_id")
    reject.add_argument("--reason", help="message the model sees instead of the tool result")
    _add_wait_flags(reject)

    wait = commands.add_parser("wait", help="wait until the session is idle or needs approval")
    wait.add_argument("session_id")
    wait.add_argument("--timeout", type=float, default=DEFAULT_WAIT_TIMEOUT_SECONDS)

    stop = commands.add_parser("stop", help="stop a session")
    stop.add_argument("session_id")

    graph = commands.add_parser(
        "graph", help="render the session Flow Definition Graph for Dex Web"
    )
    graph.add_argument("--out", type=Path, default=Path("definitions/connectors-agent.json"))
    return parser


def _add_wait_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--wait", action="store_true", help="wait until the session is idle or needs approval"
    )
    parser.add_argument("--timeout", type=float, default=DEFAULT_WAIT_TIMEOUT_SECONDS)


def _write_graph(out: Path) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_session_flow_graph(FLOW_TYPE, ACTION_PERMISSION), encoding="utf-8")
    print(f"wrote {out}")
    return 0


@asynccontextmanager
async def _open_sessions(
    settings: DemoSettings,
) -> AsyncIterator[tuple[AsyncClient, AgentSessionClient]]:
    # The Client needs the Flow's definitions only; tools and credentials stay on the Worker.
    flow = build_agent_flow([], model=settings.model, max_budget_usd=settings.max_budget_usd)
    cache = open_blob_cache(BlobCacheConfig(str(settings.blob_cache_dir / "cli"), BLOB_CACHE_BYTES))
    client = AsyncClient(
        Registry([flow], allow_async_handlers=True),
        cache,
        ClientOptions(server_address=settings.server_address),
    )
    try:
        yield client, AgentSessionClient(client, flow)
    finally:
        await client.close()
        cache.close()


async def _run(options: argparse.Namespace) -> int:
    settings = DemoSettings.from_environment()
    async with _open_sessions(settings) as (client, sessions):
        session_id = options.session_id
        if options.command == "start":
            await sessions.start_session(session_id, options.message)
            print(f"started session {session_id}")
        elif options.command == "send":
            if not await sessions.send_user_message(session_id, options.message):
                print("the session did not accept the message", file=sys.stderr)
                return 1
            print("message queued")
        elif options.command == "show":
            _print_snapshot(await sessions.get_agent_snapshot(session_id), options.messages)
            return 0
        elif options.command == "pending":
            _print_pending(await sessions.get_agent_snapshot(session_id))
            return 0
        elif options.command in ("approve", "reject"):
            is_resolved = await sessions.resolve_interrupt(
                session_id,
                options.interrupt_id,
                approved=options.command == "approve",
                rejection_message=getattr(options, "reason", None),
            )
            if not is_resolved:
                print("the interrupt is not pending", file=sys.stderr)
                return 1
            print(f"{options.command}d {options.interrupt_id}")
        elif options.command == "stop":
            await client.stop_flow(session_id)
            print(f"stopped session {session_id}")
            return 0
        if options.command == "wait" or getattr(options, "wait", False):
            snapshot = await _wait_until_settled(sessions, session_id, options.timeout)
            _print_snapshot(snapshot, 4)
    return 0


async def _wait_until_settled(
    sessions: AgentSessionClient, session_id: str, timeout_seconds: float
) -> AgentSnapshot:
    """Poll until no turn runs, or a tool call waits for a person."""
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    # Give a just-queued message time to start its turn.
    await asyncio.sleep(WAIT_POLL_SECONDS)
    while True:
        snapshot = await sessions.get_agent_snapshot(session_id)
        state = snapshot.state
        is_idle = (
            state is not None
            and state.active_turn_id is None
            and snapshot.queued_message_count == 0
        )
        if snapshot.pending_interrupts or is_idle:
            return snapshot
        if asyncio.get_running_loop().time() > deadline:
            print("timed out waiting for the session", file=sys.stderr)
            return snapshot
        await asyncio.sleep(WAIT_POLL_SECONDS)


def _print_snapshot(snapshot: AgentSnapshot, message_count: int) -> None:
    state = snapshot.state
    if state is None:
        print("session has not started yet")
        return
    print(f"status: {state.status}  turns: {state.turn_count}  active turn: {state.active_turn_id}")
    if state.last_turn_error:
        print(f"last turn error: {state.last_turn_error}")
    for message in snapshot.messages[-message_count:]:
        if message.text:
            print(f"[{message.role}] {message.text}")
        if message.tool_name:
            print(
                f"[{message.role}] tool {message.tool_name} {message.tool_arguments or ''}".rstrip()
            )
        if message.tool_output:
            print(f"[{message.role}] -> {message.tool_output[:400]}")
    for tool_call in snapshot.tool_calls:
        print(f"tool call {tool_call.tool_call_id}: {tool_call.tool_name} {tool_call.status}")
    _print_pending(snapshot)


def _print_pending(snapshot: AgentSnapshot) -> None:
    if not snapshot.pending_interrupts:
        print("no pending approvals")
        return
    for interrupt in snapshot.pending_interrupts:
        arguments = json.dumps(json.loads(interrupt.arguments) if interrupt.arguments else {})
        print(f"pending approval {interrupt.interrupt_id}: {interrupt.tool_name} {arguments}")


if __name__ == "__main__":
    sys.exit(main())
