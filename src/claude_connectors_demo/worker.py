"""Worker entry point: serve the ConnectorsAgent session Flow until SIGINT or SIGTERM.

Run it with ``uv run connectors-agent-worker`` while ``dexcli dev`` runs.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal

from dex import AsyncWorker, BlobCacheConfig, Registry, WorkerOptions, open_blob_cache

from claude_connectors_demo.agent import build_agent_flow
from claude_connectors_demo.connections import build_connector_bindings
from claude_connectors_demo.settings import DemoSettings

LOGGER = logging.getLogger("claude_connectors_demo.worker")
BLOB_CACHE_BYTES = 256 * 1024 * 1024


async def serve(settings: DemoSettings) -> None:
    """Register the agent and serve it until a stop signal arrives."""
    flow = build_agent_flow(
        build_connector_bindings(), model=settings.model, max_budget_usd=settings.max_budget_usd
    )
    registry = Registry([flow], allow_async_handlers=True)
    blob_cache = open_blob_cache(
        BlobCacheConfig(str(settings.blob_cache_dir / "worker"), BLOB_CACHE_BYTES)
    )
    worker = AsyncWorker(
        registry, blob_cache, WorkerOptions(server_address=settings.server_address)
    )
    stop_requested = asyncio.Event()
    loop = asyncio.get_running_loop()
    for stop_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(stop_signal, stop_requested.set)
    serving = asyncio.create_task(worker.start())
    try:
        await worker.wait_pull_registered(timeout=30)
        LOGGER.info(
            "worker serving %s on %s with model %s",
            flow.get_flow_type(),
            settings.server_address,
            settings.model,
        )
        stopping = asyncio.create_task(stop_requested.wait())
        await asyncio.wait({serving, stopping}, return_when=asyncio.FIRST_COMPLETED)
        stopping.cancel()
    finally:
        await worker.stop()
        with contextlib.suppress(asyncio.CancelledError):
            await serving
        blob_cache.close()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    # httpx logs request URLs at INFO; keep provider URLs and query strings out of the log.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(serve(DemoSettings.from_environment()))


if __name__ == "__main__":
    main()
