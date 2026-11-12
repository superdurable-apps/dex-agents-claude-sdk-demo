# Dex signup review agent

A demo of the [Dex](https://docs.superdurable.io) agent framework on a real business process. When
someone signs up for Dex Cloud, an agent researches the applicant, recommends approving or rejecting
the account, and drafts a personal welcome email. It posts all of that to Slack, where admins
decide, ask for changes to the email, and finally say `send`.

The whole application is the agent's **prompt and tools**. One Dex agent session per sign-up runs
the process from the first lookup to the sent email; Dex keeps it durable, so a crash, a deploy or a
week of waiting for an admin loses nothing and repeats nothing.

```text
 Dex Cloud ──list-pending──▶ SignupWatcher ──starts──▶ agent session  signup-review-<accountId>
 (ReviewAPI)                  (every 30 s)              │  get_account, github_user, fetch_profile
     ▲                                                  │  post_review ─────────────────────────▶ Slack thread
     │  approve_account / reject_account                │  waits (a durable Dex wait, no process)
     └──────────────────────────────────────────────────┤  "[slack <ts>] approve" ◀── SlackReplyRelay ◀── reviewer
                                                        │  post_draft, reply_in_thread ──────────▶ Slack thread
                            Gmail ◀── send_welcome_email┘  finish_review
```

## The prompt

From [`src/signup-agent.ts`](src/signup-agent.ts):

> You review sign-ups for Dex Cloud, a hosted platform for building durable applications and AI agents, together with the admins in Slack.
>
> 1. **Research.** Call get_account for the account in the first message. Look the applicant up: github_user for a GitHub login, fetch_profile for a profile link or personal website. Pages on x.com usually cannot be read; then say that the information is insufficient.
> 2. **Decide** on a recommendation. Never invent facts: every reason is something a tool returned, or the absence of information.
> 3. Call **post_review** once, with the recommendation, the reasons, and a personal welcome email draft. Then end your turn and wait.
> 4. Admins' replies arrive as messages `[slack <ts>] <text>`: `approve` → approve_account; `reject <reason>` → reject_account; `send` → send_welcome_email; anything else is feedback: write a new draft and call post_draft. `[dex-cloud ...]` means the account was decided in Dex Cloud admin.
> 5. When the email was sent, the account was rejected, or it was decided elsewhere, post a summary and call **finish_review**.

## The tools

| Tool | Does | Dex effect | Guard in the tool (the model cannot talk past it) |
| --- | --- | --- | --- |
| `get_account(accountId)` | ReviewAPI `get` | read | |
| `fetch_profile(url)` | One public HTTPS page as text | read | `https` only, 1 MB, 10 s, 3 redirects, every resolved address must be public |
| `github_user(login)` | GitHub public API: user and top repositories | read | |
| `read_review_thread(accountId)` | The reviewers' replies in the review thread | read | Only members in `SIGNUP_REVIEWER_SLACK_IDS` |
| `post_review(recommendation, reasons, emailSubject, emailBody)` | Slack `postChannelMessage`: the review post, draft 1, the harness, the instructions | single attempt | Once per session |
| `post_draft(subject, body)` | Slack `postThreadReply` with `[draft <n>]` | single attempt | Needs the review thread |
| `reply_in_thread(text)` | Slack `postThreadReply` | single attempt | Needs the review thread |
| `approve_account()` | ReviewAPI `approve` with the expected revision, without Dex Cloud's own approval email | idempotent | A reviewer replied `approve` in the thread. An account decided elsewhere returns `superseded`. |
| `reject_account(reason)` | ReviewAPI `reject` with the expected revision | idempotent | A reviewer replied `reject …` in the thread |
| `send_welcome_email()` | Gmail `sendMessage` of the **latest posted draft** to the applicant | single attempt | Approved in this review, still active, a reviewer replied `send` after that draft, and never attempted before |
| `finish_review()` | Ends the review | idempotent | The account is no longer pending, and an approved account got its email |

No tool asks for Dex tool approval: the approval is a reviewer's reply in Slack, and each guard reads
it from Slack itself. The guards decide from facts only: the session's own Dex state (the posted
thread and drafts are its earlier tool results), the Slack thread, and the ReviewAPI. The Slack and
Gmail tools are Dex connector tools ([`@superdurable/connector-slack`](https://www.npmjs.com/package/@superdurable/connector-slack),
[`@superdurable/connector-google-gmail`](https://www.npmjs.com/package/@superdurable/connector-google-gmail)):
each call is one connector call in its own Dex Step under the connector's call identity and dispatch
fence, so a crash never posts or sends twice. A send whose outcome Dex cannot confirm is never
repeated; the agent says in the thread that the email may have been sent (check Sent Mail).

## The harness

[`src/pi-agent.ts`](src/pi-agent.ts) is the whole harness (simplified here): Dex's built-in agent loop with a
[pi-ai](https://github.com/earendil-works/pi) model client, the prompt, and the tools.

```ts
createBuiltinAgentSessionFlow(
  {
    name: "signup-review",
    instructions: signupAgentPrompt,
    model: createPiAiModelClient(getBuiltinModels("anthropic").find((m) => m.id === "claude-opus-5-5")),
    tools: createSignupTools(services).map((tool) => functionTool({ ...tool, requiresApproval: false })),
    toolSources: [createSignupConnectorTools(services)],
  },
  "SignupReviewPiAgentFlow",
);
```

Every model call is one `RunModel` Step and every tool call its own tool Step, so Dex Web shows the
review call by call, and a crash repeats at most the one call that was running.

## The glue

[`src/signup-loops.ts`](src/signup-loops.ts) holds the only code outside the agent, two loops in the
Worker process (not Flows):

- **SignupWatcher**, every 30 seconds: lists the pending sign-ups and starts each one's session,
  FlowID `signup-review-<accountId>`, Request ID `<accountId>`, a reuse policy that rejects used
  IDs. Starting one that exists is a no-op: one review per account, ever.
- **SlackReplyRelay**, every 15 seconds: for every running session with a posted thread, forwards
  each new reviewer reply as `[slack <ts>] <text>`, sending it only when the session holds no message
  with that marker yet. Every minute it also tells a session whose account was decided in Dex Cloud
  admin (`[dex-cloud <status>]`). It stops sessions that called `finish_review`, and sessions older
  than 7 days. The relay goes away once the TypeScript Slack connector has a thread-reply Trigger.

## Run it locally

You need Node.js 22.19 or later (24 recommended, `.nvmrc`) and
[`dexcli`](https://docs.superdurable.io/components/run-locally) 1.43 or later.

1. **Start Dex** in its own terminal: `dexcli dev`. Dex Web opens on the address it prints.
2. **Create two connections** in Dex Web under **Connectors** > **+ Add**, with exactly these names:

   | Name | Connector | Authorization |
   | --- | --- | --- |
   | `review-slack` | Slack | OAuth of your Slack app. Bot scopes `chat:write`, `channels:history`, `channels:read` (`groups:history`, `groups:read` for a private channel); user scope `channels:history` (or `groups:history`): the connector posts with the bot token and reads threads with the user token. Invite the app to the review channel. |
   | `welcome-gmail` | Gmail | Google OAuth of the team mailbox that sends the emails (`gmail.send`, `gmail.readonly`, `userinfo.email`). Create a Web application OAuth client in Google Cloud, enable the Gmail API, add the redirect URI Dex Web shows. |

   Dex Web saves them to `~/.dex/connectors/connections.json`; copy its path from **Local store**.
3. **Configure:** `cp .env.example .env`, then fill in the ReviewAPI URL and key (Dex Cloud staging),
   `SLACK_REVIEW_CHANNEL`, `SIGNUP_REVIEWER_SLACK_IDS`, `DEX_CONNECTOR_CONFIG_FILE`, and
   `ANTHROPIC_API_KEY`.
4. **Start the agent:** `npm install && npm start`. It reviews every pending sign-up. Stop it with
   Ctrl+C at any time: the sessions wait in Dex and go on when it starts again.
5. **Review in Slack:** reply in the review's thread with `approve`, `reject <reason>`, or what to
   change in the email; after the approval, `send`. Watch each session `signup-review-<accountId>` in
   Dex Web.

| Variable | Meaning |
| --- | --- |
| `DEX_FLOW_SERVICE_ADDRESS` | Dex server; `127.0.0.1:8801` (`dexcli dev`) by default |
| `DEX_TLS`, `DEX_API_KEY`, `DEX_TOKEN_URL`, `DEX_SERVER_ID` | A remote Dex server: TLS, and the API key exchanged for tokens |
| `REVIEW_API_URL`, `REVIEW_API_KEY` | The Dex Cloud account review API (staging) and its key `srk_<id>_<secret>` |
| `SLACK_REVIEW_CHANNEL` | Channel ID of the review posts |
| `SIGNUP_REVIEWER_SLACK_IDS` | Comma-separated Slack member IDs whose replies count |
| `DEX_CONNECTOR_CONFIG_FILE` | The connector configuration with `review-slack` and `welcome-gmail` |
| `SIGNUP_AGENT_PI_MODEL`, `ANTHROPIC_API_KEY` | The pi-ai model (`anthropic/claude-opus-5-5`) and its key |
| `GITHUB_TOKEN` | Optional, raises the GitHub API rate limit |

## Tests

`npm test` runs the review end to end on a private local Dex engine (`dexcli dev --engine zd`, started
by the test; `dexcli` and `dex-server-zd` must be on `PATH`) with a scripted model, the Slack and Gmail
connector mocks, and a test-only ReviewAPI stub. No model, Slack, Gmail or GitHub call is made.

Scenarios: a review with one revision, approval and the email; a request to approve that no reviewer
wrote, and a send before `send`, both refused; a bystander's reply ignored and each reply relayed
once; a rejection; an account decided in Dex Cloud admin.

## License

MIT, see [LICENSE](LICENSE).
