# Shared clan chat

Run `clqn` in a terminal after signing in and selecting a clan with `clqn init` or `clqn join`. The clan leader starts the shared session from the setup screen. Members join it from the same screen. The transcript stays with the clan between terminal sessions.

Type a task, question, or project context and press **Enter**. Messages remain queued until the orchestrator picks them up. The agent pane shows each delegation's task, worker, status, and reported tokens. A tilde marks estimated usage.

The footer graph shows cumulative reported tokens across the clan over the latest 24 hourly buckets. It grows as workers report usage and excludes estimates. History starts when the server enables recording.

| Key | Action |
| --- | --- |
| F2 | Open session settings. Use the arrow keys to move between fields and change approval mode. |
| F3 or Tab | Focus a spawn proposal. Use the arrow keys to choose one, then press **Y** to approve or **N** to decline. |
| F4 | Reply to a clarification. Press it again to choose a different question. |
| Page Up / Page Down | Scroll the transcript. Press **End** to return to the latest messages. |
| Ctrl+C | Close the terminal session. |

Session defaults are manual approval, 50,000 tokens, and 3 active agents. A saved clan policy supplies the initial token limit and approval mode when available. Set either limit to `none` for unlimited. Settings are saved for your next visit. Both manual and automatic approval check the worker owner's limits. Queued assignments reserve an agent slot and their estimated tokens. Reported usage draws down the budget, and completed work without a report counts at its estimate. The API gates new delegations. The local runner controls model execution and reports actual usage.

## Connect the orchestrator and workers

The leader registers a coordinator with `clqn agent add coordinator --orchestrator` and opens it in a separate terminal with `clqn agent run coordinator`. Workers use `clqn agent run` with their own credentials. These commands open Codex or Claude Code with Clqn’s MCP tools connected. Ask the coordinator to check the chat inbox as part of its workflow. Messages stay queued while the coordinator is offline.

- The orchestrator reads `clqn_chat_inbox` and calls `clqn_chat_decide` on queued messages. It replies to questions, acknowledges context, or proposes a delegation to a registered worker. When instructions conflict, it asks a specific question and can hold the affected work, including an approved assignment that has yet to be claimed. It can keep handling unrelated messages while members clarify. A linked clarification reply goes back into the queue.
- Workers read their assigned tasks, claim work through the existing task tools, and call `clqn_chat_report` with cumulative input and output tokens. They can post a result to the shared chat in the same call. Finalize work with the existing task completion flow.

The Cloud Run API stores the transcript, proposals, and settings in PostgreSQL. Apply the [release migrations](hosting.md#migrate-then-deploy) before deploying the updated API.
