# Chat and keys

Run `clqn` in your project clone. Everyone sees the same chat, and the server saves messages between sessions. The leader's `clqn` normally hosts the orchestrator.

## Set up backup hosts

The leader nominates one or more clan members by email or user ID.

```sh
clqn host alex@example.com sam@example.com
```

Run `clqn host` to see the list. Passing names replaces the list. Run `clqn host off` to clear it.

Each nominated member opens ordinary `clqn` and enables **Backup hosting** in chat settings on the device they want to use. Keep chat open with a signed-in Codex or Claude Code runtime enabled. The current host runs the orchestrator using their existing agent CLI and account.

When the active host exits normally, an opted-in backup with chat open can take over on its next check. After a disconnect, the last heartbeat expires within 45 seconds. The next host uses shared chat history and picks up unfinished requests.

One host routes messages for the clan. If a backup is already active, a returning leader or another backup waits its turn. Messages stay saved when every eligible host is offline.

## Send a message

Type a task, question, or piece of project context and press **Enter**. The orchestrator routes each message and can split a single request into independent tasks. Up to five task sub-orchestrators can plan in parallel on the active host's machine and AI account. You can keep sending messages while they work.

Refer to a task by name when you send a follow-up. The orchestrator sends it to that task and makes it available to its approved worker. An active Codex or Claude Code worker receives the update in its current session at the next runtime opportunity.

Press **Ctrl+F** to give a draft priority in routing. Task planning and approved workers can continue while the host routes it.

If the orchestrator needs more detail, a question appears above the composer. Press **Ctrl+Q**, type your answer, and press **Enter**.

## Approve agents

When the orchestrator wants to start an agent on your machine, you see a **Spawn** line with the task, model, and estimated tokens. Press **Ctrl+P** to focus it, use **↑ ↓** to choose if there are several, then press **Y** to approve or **N** to decline.

To approve automatically, set **Spawn approval** to **Automatic** in settings. Your [limits](policies.md) apply either way.

The **Agents** panel on the right lists each task with its worker, status, and tokens. A tilde (`~40k`) marks an estimate until the worker reports real usage.

## Review pull requests

When a worker finishes code changes, clqn commits them on the task's own branch, pushes, opens a pull request, and posts the link in chat. Press **Ctrl+L** to see pull requests. The clan leader reviews the PR on GitHub, then presses **Y** to approve the merge or **N** to decline. clqn merges once the GitHub checks pass. See the [repository workflow](repositories.md).

## Keys

On macOS, use the **Ctrl** keys: function keys usually control brightness and volume unless you hold **fn**.

| Key | Action |
| --- | --- |
| Enter | Send your message |
| Ctrl+F | Force-send your message |
| Ctrl+P (F3, Tab) | Focus spawn approvals. **↑ ↓** to choose, **Y** approve, **N** decline, **Esc** back |
| Ctrl+Q (F4) | Reply to the orchestrator's question. Press again to pick another question |
| Ctrl+L (F6) | Pull requests. The leader presses **Y** to approve a merge or **N** to decline |
| Ctrl+S (F2) | Settings |
| Ctrl+G (F5) | Metrics. **T** or **Tab** switches between 24 hours and 7 days |
| Mouse wheel, ↑ ↓, Page Up, Page Down | Scroll chat history. **End** jumps back to the latest. To select text, hold **Option** (iTerm2, Terminal) or **Shift** (most others) while dragging |
| Ctrl+R | Retry a message that failed to send |
| Ctrl+C | Quit |

## Settings

Press **Ctrl+S**. Move with **↑ ↓**, change a value with **← →**, type numbers or model names, then choose **Save settings**.

| Setting | What it does |
| --- | --- |
| Spawn approval | **Manual** (default) asks before each agent starts. **Automatic** approves within your limits |
| Token limit | Total tokens your agents can use in this clan. `none` for no limit |
| Agent limit | How many of your agents can run at once. `none` for no limit |
| Models | Comma-separated model IDs your agents may use. Blank allows any |
| Worker commands | What your agents may run: **Off**, **Sandboxed** (default, inside the agent's sandbox), or **Unrestricted** |
| Agents | Which installed agent CLIs (Claude Code, Codex) the orchestrator can use |
| Invite | Leaders only. Type a teammate's email and press **Enter** to invite them. Invitations expire after seven days |
| Sign out | Revoke this computer's sign-in |

## Metrics

Press **Ctrl+G** for tokens and active agents over time, tokens by member and by task, and how long messages waited in the queue.

## How tokens are counted

A worker's tokens are its input, cache writes, and output, summed over the run. Cache reads are left out: each call resends the whole conversation, mostly from the prompt cache, so counting those reads would count the same context again on every call. For Codex, cached input is subtracted from input tokens.

Tokens are not dollars: cache writes and output cost more per token than plain input. Orchestrator runs are not counted.

While a task is queued or running, its estimate is reserved against your token limit. When the worker reports usage, the real count replaces the estimate. Finished work with no report counts at its estimate.
