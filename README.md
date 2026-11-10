# dex-agents-claude-sdk-demo

A durable [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python)
agent that runs on [Dex](https://github.com/superdurable/dex) through
[`dex-agents-claude-agent-sdk`](https://pypi.org/project/dex-agents-claude-agent-sdk/).
Its tools are operations from the
[Dex Connectors Library](https://github.com/superdurable/dex-connectors-library):
Hacker News, Slack, Gmail, YouTube, Reddit, and Spotify.

The session keeps its conversation, approvals, and tool results in Dex. A tool
that changes something, such as posting to Slack, waits for a person to approve
it, for as long as it takes, and then runs exactly once in its own Dex Step.

## How it works

`src/claude_connectors_demo/connector_tools.py` is a generic bridge. It reads
each connector package's `dex-connector.json` and turns every enabled operation
into a Claude Agent SDK custom tool:

| Connector operation | Tool | Dex policy | Where it runs |
| --- | --- | --- | --- |
| Query, such as Hacker News `getItem` | `hackernews_get_item` | `READ` | Inside the model turn, through `run_query` |
| Mutation, such as Slack `postThreadReply` | `slack_post_thread_reply` | `IDEMPOTENT_WRITE`, approval required | Its own `CallTool` Step after `AwaitToolApproval`, through `run_mutation` |

- The tool's input schema is the manifest's `inputSchema`. Arguments are
  decoded into the connector's input type with the Dex codec.
- The tool description is the manifest description, or the connector author's
  agent description when the manifest has one.
- A mutation's connector `CallID` is a UUIDv5 of the session's idempotency key
  `<session>/<turn>/<tool call>`. Every Dex retry of the Step sends the same
  connector idempotency key.
- A mutation also gets the Step's heartbeat checkpoints, so a connector's
  single-dispatch fence carries over to the next attempt of the Step: it sends
  again only when the earlier attempt proved nothing was sent.

Results become what the model reads:

| Connector result | Tool result |
| --- | --- |
| The happy-path branch | `{"branch": ..., "value": ...}` as JSON |
| A branch the manifest marks `rejected`, or any other query branch | An error result with the connector's safe failure message. A rejected mutation says nothing was changed. |
| `uncertain`, `defect`, or another mutation branch the manifest does not classify | An error result that says the outcome is unknown and tells the model not to call the tool again. A mutation `defect` is always unknown, even when the manifest marks it `rejected`, because `run_mutation` also selects it after the operation ran, such as for an invalid receipt. |
| `RetryError` in a mutation | Raised, so Dex retries the Step with the same `CallID`. After 3 attempts the session records `outcome_unknown`. |
| `RetryError` in an inline query | Retried in place up to 3 times, then an error result that says nothing was changed |
| Output longer than 16,000 characters | A JSON object with `"truncated": true`, the original length, and a bounded `preview` |

The operations each connector offers are listed explicitly in
`ENABLED_OPERATIONS` in `src/claude_connectors_demo/connections.py`.

## Requirements

- [uv](https://docs.astral.sh/uv/) and Python 3.11 or later.
- `dexcli` 1.40 or later, which runs a local Dex Server and Dex Web.
- An Anthropic API key in `ANTHROPIC_API_KEY`. The Worker runs the Claude Code
  CLI that ships with `claude-agent-sdk`, and the CLI reads the key from the
  environment. This app has no login code and never reads Claude credentials.

## Run it

```bash
uv sync

# 1. Render the session Flow Definition Graph, so Dex Web can draw sessions and offer approvals.
uv run connectors-agent graph --out definitions/connectors-agent.json

# 2. Start Dex locally with Dex Web on http://localhost:8802.
dexcli dev --flow-rendering-dir ./definitions

# 3. In another terminal, start the Worker.
export ANTHROPIC_API_KEY=...          # your key
uv run connectors-agent-worker
```

The Worker logs which connectors it registered. Hacker News needs no
credentials. Set `DEMO_SLACK_MOCK=1` to use the Slack connector's own mock
instead of the Slack API.

Talk to the agent with the CLI:

```bash
uv run connectors-agent start demo-1 "What is the top story on Hacker News?" --wait
uv run connectors-agent send demo-1 "Post its title as a reply in Slack thread 1710000000.000100 of channel C0123456789." --wait
uv run connectors-agent pending demo-1
uv run connectors-agent approve demo-1 <interrupt-id> --wait
uv run connectors-agent reject demo-1 <interrupt-id> --reason "Not that thread"
uv run connectors-agent show demo-1
uv run connectors-agent stop demo-1
```

`--wait` waits until the session is idle or a tool call needs approval.

### Approve in Dex Web

Dex Web reads the graph from `--flow-rendering-dir` when it starts. Open
<http://localhost:8802/v2>, open the `ConnectorsAgent` run, and use the
`resolve_interrupt` Action with the interrupt ID from the run's
`PendingInterrupts` state or from `connectors-agent pending`. Every Action
requires the permission `connectors-agent.operate`. Render the graph again
after you upgrade `dex-agents`, and restart `dexcli dev` after the file changes.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEX_SERVER_ADDRESS` | `localhost:8801` | Dex gRPC address |
| `DEX_BLOB_CACHE_DIR` | `.dex-cache` | Local BlobCache directory |
| `DEMO_CLAUDE_MODEL` | `claude-sonnet-5-5` | Claude model ID |
| `DEMO_MAX_BUDGET_USD` | `1.0` | Spending cap of one turn segment |
| `DEMO_SECRETS_FILE` | `.secrets/connectors.json` | Connector credentials file |
| `DEMO_SLACK_MOCK` | unset | `1` uses `slackmock` instead of the Slack API |

## Connector credentials

Put credentials in environment variables, or in `.secrets/connectors.json`
(gitignored; see `examples/connectors.example.json`). An environment variable
wins over the file. Credentials stay in the Worker process. They never enter
Flow state, tool output, or logs. A connector without credentials is not
registered.

The demo takes static access tokens. They are not refreshed, so get a new one
when it expires. Production applications use the connectors' Dex Web
connections and refresh drivers instead.

| Connector | Operations | Variables | How to get a token |
| --- | --- | --- | --- |
| Hacker News | `listStoryIDs`, `getItem` | none | Public API |
| Slack | `listThreadMessages`, `getThreadReply` (user token); `postChannelMessage`, `postThreadReply` (bot token) | `SLACK_USER_TOKEN`, `SLACK_BOT_TOKEN` | Create an app at <https://api.slack.com/apps>. Add bot scopes `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`, `chat:write`, and user scopes `channels:history`, `groups:history`. Install it, copy the Bot User OAuth Token (`xoxb-`) and User OAuth Token (`xoxp-`), and invite the bot to the channel. |
| Gmail | `getMessage`, `sendMessage`, `replyToMessage` | `GMAIL_ACCESS_TOKEN`, `GMAIL_PRIMARY_EMAIL` | In the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), authorize `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.send`, then exchange the code for an access token. Set the mailbox address too. Tokens last about an hour. |
| YouTube | `searchVideos`, `getVideo`, `getChannel`, `listPlaylistItems` | `YOUTUBE_ACCESS_TOKEN` | In the OAuth 2.0 Playground, authorize `https://www.googleapis.com/auth/youtube.readonly`. `addPlaylistItem` is not offered: after an insert that took effect but returned a malformed answer, the connector asks for a retry and checks only a playlist listing that can lag, so a retried Step can insert the video twice. |
| Reddit | `getPost` | `REDDIT_ACCESS_TOKEN`, `REDDIT_CLIENT_ID`, `REDDIT_USERNAME` | Create a script app at <https://www.reddit.com/prefs/apps> and get a token with the `read` scope from `https://www.reddit.com/api/v1/access_token` ([OAuth2 guide](https://github.com/reddit-archive/reddit/wiki/OAuth2)). The client ID and username build the required User-Agent. |
| Spotify | `listPlaylistTracks` | `SPOTIFY_ACCESS_TOKEN` | Create an app in the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and get a user token with the `playlist-read-private` scope through the [authorization code flow](https://developer.spotify.com/documentation/web-api/tutorials/code-flow). |

## Tests

The tests start a private `dexcli dev` engine and a Worker process, and run
the real Claude Code CLI against a scripted local Messages API with a dummy
key, so they make no model calls and need no credentials. Connector calls go to
the Slack connector's own mock.

```bash
DEXCLI="$(which dexcli)" uv run pytest
uv run ruff check src tests
```

They cover an inline query, a query failure branch, a mutation that waits for
approval and runs once with the expected `CallID`, a connector retry that
reruns the Step with the same `CallID`, a rejection, a provider rejection, and
an uncertain outcome. They also cover an inline query that retries in place,
one that runs out of retries, a mutation that writes and then returns an
invalid receipt (reported as an unknown outcome), and output truncation. One
more test runs the real Slack client against a scripted HTTP transport: its
first post gets a 503, and the retried Step posts again only because the
fence's checkpoint from the first attempt allows it.

Known gaps:

- No test runs a Gmail write or any YouTube, Reddit, or Spotify operation, mocked
  or live.
- No test runs several sessions at once.
- The scripted model always answers after one tool result, so the tests show
  the text the model receives for an unknown outcome, not that a real model
  refrains from calling the tool again.

## Notes and limits

- The connector packages are installed from the connectors library at a pinned
  commit. They pin different exact `dex-connectors-sdk` versions (Hacker News
  0.1.0, Gmail 0.6.0, the others 0.7.0), so `pyproject.toml` overrides it to
  0.7.0 for all of them.
- `claude-agent-sdk` is pinned to 0.2.176, the version whose bundled Claude Code
  CLI the adapter verifies.
- A tool handler has no Dex run ID or Flow start time. Connectors that use
  them for a provider-side identity, such as Gmail's Message-ID, get values that
  stay the same for every attempt of one tool call.
- Every turn after the first, and every continuation after an approval, runs
  the Claude Code CLI with a temporary configuration directory that the Claude
  Agent SDK prepares from the stored transcript. `ANTHROPIC_API_KEY` in the
  environment carries over to it.
- The connectors' Dex Web connections, OAuth refresh, and Triggers are not
  used here.
