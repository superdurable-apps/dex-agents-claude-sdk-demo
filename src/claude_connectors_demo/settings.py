"""Demo settings, read from the environment in one place."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_MODEL = "claude-sonnet-5-5"


@dataclass(frozen=True)
class DemoSettings:
    """Settings of the Worker and the CLI.

    Attributes:
        server_address: Dex gRPC address. ``DEX_SERVER_ADDRESS``; default
            ``localhost:8801``, the ``dexcli dev`` default.
        blob_cache_dir: Local BlobCache directory. ``DEX_BLOB_CACHE_DIR``;
            default ``.dex-cache``.
        model: Claude model ID. ``DEMO_CLAUDE_MODEL``; default
            ``claude-sonnet-5-5``.
        max_budget_usd: Spending cap of one turn segment, passed to the Claude
            Agent SDK. ``DEMO_MAX_BUDGET_USD``; default ``1.0``.
    """

    server_address: str
    blob_cache_dir: Path
    model: str
    max_budget_usd: float

    @classmethod
    def from_environment(cls) -> DemoSettings:
        return cls(
            server_address=os.environ.get("DEX_SERVER_ADDRESS") or "localhost:8801",
            blob_cache_dir=Path(os.environ.get("DEX_BLOB_CACHE_DIR") or ".dex-cache"),
            model=os.environ.get("DEMO_CLAUDE_MODEL") or DEFAULT_MODEL,
            max_budget_usd=float(os.environ.get("DEMO_MAX_BUDGET_USD") or "1.0"),
        )
