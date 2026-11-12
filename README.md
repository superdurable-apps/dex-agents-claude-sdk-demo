# Dex signup review agent

A demo of the [Dex](https://docs.superdurable.io) agent framework on a real business process. When
someone signs up for Dex Cloud, an agent reads the applicant's public profile, recommends approving
or rejecting the account, and drafts a personal welcome email. A Dex Flow posts the recommendation
to Slack, where an admin decides, revises the email in the thread, and sends it through Gmail.

```text
Dex Cloud (sign-ups waiting for approval)
      ^  ReviewAPI: list-pending, get, approve, reject (API key)
      |
SignupWatcher --StartFlow--> SignupReviewFlow (one per sign-up)
  every 30 s                   |- starts the agent session: profile lookup -> recommendation + email draft
                               |- Slack: posts the review in the review channel
                               |- polls the thread: approve | reject <reason> | feedback | send
                               |- ReviewAPI: approves or rejects with the expected revision
                               |- feedback -> the agent writes the next draft -> posted in the thread
                               '- send -> Gmail sends the email -> "sent" in the thread
```

- **The agent judges and writes; the Flow acts.** The agent session only reads (a public page, the
  GitHub API) and submits a structured review. Every write (the Slack posts, the account decision,
  the email) is a Step of `SignupReviewFlow`, a deterministic Dex Flow, with a stable identity and
  recovery rules, so a crash or a restart never repeats or loses one.
- **Two harnesses, one agent.** The same tools, instructions and Flow run on
  [pi](https://github.com/earendil-works/pi), and soon on the Claude Agent SDK; `SIGNUP_AGENT_HARNESS`
  picks one, and the Slack post names it.
- **Connectors.** Slack and Gmail are the released Dex connectors
  [`@superdurable/connector-slack`](https://www.npmjs.com/package/@superdurable/connector-slack) and
  [`@superdurable/connector-google-gmail`](https://www.npmjs.com/package/@superdurable/connector-google-gmail).
  Their credentials stay in the Dex connector configuration and never enter Flow state.

## Run it locally

You need Node.js 22.19 or later (24 recommended, see `.nvmrc`) and
[`dexcli`](https://docs.superdurable.io/components/run-locally) 1.43 or later.

1. **Start Dex** in its own terminal. It stays in the foreground; Dex Web opens on the address it prints.

   ```bash
   dexcli dev
   ```

2. **Create the two connections** in Dex Web, under **Connectors** > **+ Add**. The application opens
   them by these exact names:

   | Name | Connector | Authorization |
   | --- | --- | --- |
   | `review-slack` | Slack | OAuth of your Slack app. Bot scopes `chat:write`, `channels:history`, `channels:read` (plus `groups:history`, `groups:read` for a private channel); user scopes `channels:history` (or `groups:history`): the connector posts with the bot token and reads thread replies with the user token. Invite the app to the review channel. |
   | `welcome-gmail` | Gmail | Google OAuth of the team mailbox the welcome emails come from (scopes `gmail.send`, `gmail.readonly`, `userinfo.email`). Create a Web application OAuth client in Google Cloud, enable the Gmail API, and add the redirect URI that Dex Web shows. |

   Dex Web saves them to `~/.dex/connectors/connections.json` (mode 0600). Copy its path from the
   **Local store** zone.

3. **Configure** the application:

   ```bash
   cp .env.example .env
   ```

   Fill in `REVIEW_API_URL` and `REVIEW_API_KEY` (the Dex Cloud staging review API and its key),
   `SLACK_REVIEW_CHANNEL`, `SIGNUP_REVIEWER_SLACK_IDS` (only these members' replies count),
   `DEX_CONNECTOR_CONFIG_FILE`, and the model key of the harness.

4. **Start the agent:**

   ```bash
   npm install
   npm start
   ```

   It prints `Signup agent ready ...`, then starts a review for every pending sign-up it finds.
   Stop it with Ctrl+C at any time: the reviews wait in Dex and continue when it starts again.

5. **Review in Slack.** Reply in the review's thread:
   - `approve`, or `reject <reason>`, to decide on the account;
   - anything else is feedback: the agent writes the next draft of the email and posts it;
   - after the approval, `send` sends the current draft to the applicant.

   Watch each review in Dex Web: the Flow `signup-review-<accountId>` and its agent session
   `signup-review-<accountId>-agent`, Step by Step.

### Configuration

| Variable | Meaning |
| --- | --- |
| `DEX_FLOW_SERVICE_ADDRESS` | Dex server address; `127.0.0.1:8801` (local `dexcli dev`) by default. |
| `DEX_TLS`, `DEX_API_KEY`, `DEX_TOKEN_URL`, `DEX_SERVER_ID` | A remote Dex server: TLS, and the API key exchanged for tokens. |
| `REVIEW_API_URL`, `REVIEW_API_KEY` | The Dex Cloud account review API and its key (`srk_<id>_<secret>`). The demo reviews Dex Cloud staging. |
| `SLACK_REVIEW_CHANNEL` | Channel ID of the review posts. |
| `SIGNUP_REVIEWER_SLACK_IDS` | Comma-separated Slack member IDs allowed to decide. Replies of anyone else are ignored. |
| `DEX_CONNECTOR_CONFIG_FILE` | The Dex connector configuration with `review-slack` and `welcome-gmail`. |
| `SIGNUP_AGENT_HARNESS` | `pi` (default). New reviews use it; a running review keeps its harness. |
| `SIGNUP_AGENT_PI_MODEL`, `ANTHROPIC_API_KEY` | pi: the pi-ai model, `anthropic/claude-opus-5-5` by default, and its provider key. |
| `GITHUB_TOKEN` | Optional, raises the GitHub API rate limit of `github_user`. |
| `SIGNUP_WATCH_INTERVAL_SECONDS` | Seconds between two reads of the pending sign-ups; 30 by default. |

## The harnesses

| | pi |
| --- | --- |
| Agent session Flow type | `SignupReviewPiAgentFlow` |
| Who runs the loop | Dex's built-in agent loop; pi-ai makes each model call |
| What Dex Web shows | One `RunModel` Step per model call and one `CallTool` Step per tool call |
| Model | `anthropic/claude-opus-5-5` with `ANTHROPIC_API_KEY` |

With pi, every model call and every tool call is a Dex Step, so a crash repeats at most the one call
that was running, and Dex Web shows the agent's work call by call.

## How a review runs

`SignupReviewFlow` (FlowID `signup-review-<accountId>`) has these Steps:

| Step | What it does |
| --- | --- |
| `LoadAccount` | Reads the account; a sign-up that is no longer pending ends as `superseded`. |
| `StartAgentSession` | Starts the agent session `signup-review-<accountId>-agent` with the applicant's data. |
| `AwaitAgentReview` | Polls the session until the turn ends and reads the arguments of its `submit_review` call. A turn without one gets one reminder. |
| `PostReview`, `RepostReview` | Posts the review to the channel. |
| `AwaitThreadReply` | Polls the thread every 15 seconds for the next reviewer command, for up to 7 days, and checks every minute whether the account was decided in Dex Cloud admin. |
| `DecideAccount` | Approves (without Dex Cloud's own approval email) or rejects, with the account's expected revision. |
| `RequestRevision` | Sends the feedback to the agent session for the next draft. |
| `PostThreadReply`, `RepostReply` | Posts one reply in the thread. |
| `SendWelcomeEmail` | Sends the current draft from the team mailbox. |
| `RecordFailure`, `Finish`, `StopAgentSession` | Record the outcome, stop the agent session, complete. |

The Phase Attribute (indexed) tells where a review stands: `analyzing`,
`awaiting_account_decision`, `reviewing_email`, `sending`, then `done`, `rejected`, `superseded`,
`timed_out` or `failed`.

How each write stays single:

- **Account decision.** The request ID is `<FlowID>-<approve|reject>-r<revision>` and the request
  carries the expected revision. A repeated request answers the applied result; a revision conflict
  means someone decided in Dex Cloud admin first: the thread says so and the review ends.
- **Slack posts.** Each post runs in its own Step under the connector's call identity, which Dex
  keeps across the Step's retries, and the connector's dispatch fence never sends one call twice.
  When a reply's outcome is uncertain, the Flow looks for the reply's marker
  (`[signup-review-<accountId> #<n>]`) in the thread and posts again only if it is missing. An
  uncertain root post has no thread to look in, and the Slack connector reads no channel history
  yet, so it is posted once more with a note: at most one duplicate post.
- **Agent messages.** `send_user_message` has no idempotency key, so a revision request starts with
  the marker `[draft <n>]`, and a retried Step sends it only when the session holds no such message.
- **Email.** The Gmail connector derives the message's RFC Message-ID from the call identity and
  searches Sent Mail before it sends again, so the Step's retries never send twice. If the Step still
  fails, the review ends `failed` and says in the thread that the email may have been sent.

## Tests

The tests run `SignupReviewFlow` end to end on a private local Dex engine (`dexcli dev --engine zd`,
started by the test) with a scripted model, the Slack and Gmail connectors' mock packages, and a
small test-only ReviewAPI stub (`test/support/review-api-test-stub.ts`). They make no model, Slack,
Gmail or GitHub calls.

```bash
npm test
```

`dexcli` and `dex-server-zd` must be on `PATH`, or set `DEXCLI` and `DEX_SERVER_ZD_BINARY`.

The scenarios: an approval with one revision and one email; a rejection after a reminder; a sign-up
decided in Dex Cloud admin while the thread waits; an approval that conflicts with such a decision;
a retried root post under one call identity; and an uncertain thread reply that is found by its
marker and not posted again.

## License

MIT; see [LICENSE](LICENSE).
