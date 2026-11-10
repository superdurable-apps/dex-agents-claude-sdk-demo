"""Build connector connections from local credentials, and the agent's connector config.

Credentials come from environment variables, or from the gitignored JSON file
that ``DEMO_SECRETS_FILE`` names (default ``.secrets/connectors.json``). An
environment variable wins over the file. Each connector holds its credentials in
a ``StaticCredentialProvider`` inside the Worker process only: they never enter
Flow state, tool output, or logs. A connector without credentials is not
registered, and the Worker logs that once.

Hacker News needs no credentials. ``DEMO_SLACK_MOCK=1`` replaces Slack with the
connector's own ``slackmock``, which answers from the manifest's mock scripts.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dex_connectors import google_gmail, google_youtube, hackernews, reddit, slack, spotify
from dex_connectors.sdk import ConnectionRef, SecretString, StaticCredentialProvider
from dex_connectors.slack import slackmock

from claude_connectors_demo.connector_tools import ConnectorBinding

LOGGER = logging.getLogger(__name__)

SECRETS_FILE_ENVIRONMENT_VARIABLE = "DEMO_SECRETS_FILE"
DEFAULT_SECRETS_FILE = Path(".secrets/connectors.json")
SLACK_MOCK_ENVIRONMENT_VARIABLE = "DEMO_SLACK_MOCK"
CONNECTION_NAME = "agent"

# The operations each connector offers the agent, by manifest operationId. Keep this explicit.
ENABLED_OPERATIONS: Mapping[str, tuple[str, ...]] = {
    "hackernews": ("listStoryIDs", "getItem"),
    "slack": ("listThreadMessages", "getThreadReply", "postChannelMessage", "postThreadReply"),
    "gmail": ("getMessage", "sendMessage", "replyToMessage"),
    # No addPlaylistItem: a retry after an accepted insert can insert the video twice.
    "youtube": ("searchVideos", "getVideo", "getChannel", "listPlaylistItems"),
    "reddit": ("getPost",),
    "spotify": ("listPlaylistTracks",),
}

# Secret names per connector: the environment variable, and the key in the secrets file.
SECRET_ENVIRONMENT_VARIABLES: Mapping[str, Mapping[str, str]] = {
    "slack": {"bot_token": "SLACK_BOT_TOKEN", "user_token": "SLACK_USER_TOKEN"},
    "gmail": {"access_token": "GMAIL_ACCESS_TOKEN", "primary_email": "GMAIL_PRIMARY_EMAIL"},
    "youtube": {"access_token": "YOUTUBE_ACCESS_TOKEN"},
    "reddit": {
        "access_token": "REDDIT_ACCESS_TOKEN",
        "client_id": "REDDIT_CLIENT_ID",
        "username": "REDDIT_USERNAME",
    },
    "spotify": {"access_token": "SPOTIFY_ACCESS_TOKEN"},
}


@dataclass(frozen=True)
class ConnectorSecrets:
    """Secret values of one connector, read once at Worker startup."""

    values: Mapping[str, str]

    def get(self, name: str) -> str:
        return self.values.get(name, "").strip()

    def has(self, *names: str) -> bool:
        return all(self.get(name) for name in names)


def build_connector_bindings() -> list[ConnectorBinding]:
    """Return a binding for every connector this machine can use, logging the others."""
    secrets_by_connector = read_connector_secrets()
    builders: dict[str, Callable[[ConnectorSecrets], object | None]] = {
        "hackernews": _hackernews_connection,
        "slack": _slack_connection,
        "gmail": _gmail_connection,
        "youtube": _youtube_connection,
        "reddit": _reddit_connection,
        "spotify": _spotify_connection,
    }
    bindings = []
    for tool_prefix, build_connection in builders.items():
        connection = build_connection(secrets_by_connector.get(tool_prefix, ConnectorSecrets({})))
        if connection is None:
            LOGGER.info(
                "connector %s is not registered: its credentials are not configured", tool_prefix
            )
            continue
        bindings.append(
            ConnectorBinding(
                tool_prefix=tool_prefix,
                package=_PACKAGES[tool_prefix],
                connection=connection,
                enabled_operation_ids=ENABLED_OPERATIONS[tool_prefix],
            )
        )
        LOGGER.info("connector %s is registered", tool_prefix)
    return bindings


def read_connector_secrets() -> dict[str, ConnectorSecrets]:
    """Merge the secrets file and the environment; the environment wins."""
    file_values = _read_secrets_file()
    secrets: dict[str, ConnectorSecrets] = {}
    for connector, names in SECRET_ENVIRONMENT_VARIABLES.items():
        values = {
            name: str(value)
            for name, value in (file_values.get(connector) or {}).items()
            if isinstance(value, str)
        }
        for name, environment_variable in names.items():
            environment_value = os.environ.get(environment_variable, "").strip()
            if environment_value:
                values[name] = environment_value
        secrets[connector] = ConnectorSecrets(values)
    return secrets


def _read_secrets_file() -> dict[str, Any]:
    path = Path(os.environ.get(SECRETS_FILE_ENVIRONMENT_VARIABLE) or DEFAULT_SECRETS_FILE)
    if not path.is_file():
        return {}
    document = json.loads(path.read_text("utf-8"))
    if not isinstance(document, dict):
        raise ValueError(f"{path} must hold a JSON object keyed by connector")
    return document


_PACKAGES: Mapping[str, str] = {
    "hackernews": "dex_connectors.hackernews",
    "slack": "dex_connectors.slack",
    "gmail": "dex_connectors.google_gmail",
    "youtube": "dex_connectors.google_youtube",
    "reddit": "dex_connectors.reddit",
    "spotify": "dex_connectors.spotify",
}


def _hackernews_connection(secrets: ConnectorSecrets) -> object:
    reference = ConnectionRef("hackernews", CONNECTION_NAME)
    return hackernews.new_connection(hackernews.Client(hackernews.Config()), reference)


def _slack_connection(secrets: ConnectorSecrets) -> object | None:
    if os.environ.get(SLACK_MOCK_ENVIRONMENT_VARIABLE) == "1":
        LOGGER.info("connector slack uses slackmock, not the Slack API")
        return slackmock.Mock(CONNECTION_NAME).connection()
    if not (secrets.has("bot_token") or secrets.has("user_token")):
        return None
    reference = ConnectionRef("slack", CONNECTION_NAME)
    empty = SecretString("")
    credentials = slack.Credentials(
        oauth_client_id="",
        oauth_client_secret=empty,
        bot_token=SecretString(secrets.get("bot_token")),
        bot_refresh_token=empty,
        user_token=SecretString(secrets.get("user_token")),
        user_refresh_token=empty,
        app_token=empty,
    )
    client = slack.Client(slack.Config(), StaticCredentialProvider({reference: credentials}))
    return slack.new_connection(client, reference)


def _gmail_connection(secrets: ConnectorSecrets) -> object | None:
    if not secrets.has("access_token", "primary_email"):
        return None
    reference = ConnectionRef("google", CONNECTION_NAME)
    credentials = google_gmail.Credentials(
        access_token=SecretString(secrets.get("access_token")),
        primary_email=secrets.get("primary_email"),
    )
    provider = google_gmail.GmailProvider(
        google_gmail.Config(), StaticCredentialProvider({reference: credentials})
    )
    return google_gmail.new_connection(provider, reference)


def _youtube_connection(secrets: ConnectorSecrets) -> object | None:
    if not secrets.has("access_token"):
        return None
    reference = ConnectionRef("google", CONNECTION_NAME)
    credentials = google_youtube.Credentials(
        auth_method_id="google-oauth-readonly",
        access_token=SecretString(secrets.get("access_token")),
    )
    client = google_youtube.Client(
        google_youtube.Config(), StaticCredentialProvider({reference: credentials})
    )
    return google_youtube.new_connection(client, reference)


def _reddit_connection(secrets: ConnectorSecrets) -> object | None:
    if not secrets.has("access_token", "client_id", "username"):
        return None
    reference = ConnectionRef("reddit", CONNECTION_NAME)
    credentials = reddit.Credentials(
        oauth_client_id=secrets.get("client_id"),
        oauth_client_secret=SecretString(""),
        access_token=SecretString(secrets.get("access_token")),
        refresh_token=SecretString(""),
    )
    client = reddit.Client(
        reddit.Config(reddit_username=secrets.get("username")),
        StaticCredentialProvider({reference: credentials}),
    )
    return reddit.new_connection(client, reference)


def _spotify_connection(secrets: ConnectorSecrets) -> object | None:
    if not secrets.has("access_token"):
        return None
    reference = ConnectionRef("spotify", CONNECTION_NAME)
    credentials = spotify.Credentials(
        oauth_client_id="",
        oauth_client_secret=SecretString(""),
        access_token=SecretString(secrets.get("access_token")),
        refresh_token=SecretString(""),
    )
    client = spotify.Client(spotify.Config(), StaticCredentialProvider({reference: credentials}))
    return spotify.new_connection(client, reference)
