# Chat and keys

Run `clqn` in your project clone. Everyone in the clan sees the same chat, and it's saved between sessions. With cloud orchestration enabled, any clan member can open chat and start working even if everyone else is offline. [Set up cloud orchestration](hosting.md#cloud-orchestrator) for a self-hosted API.

## Send a message

Type a task, question, or piece of project context and press **Enter**. Messages wait in a queue. The orchestrator handles one at a time, oldest first, and shows the one it's working on as **Processing**. Its answer appears right below your message.

The cloud orchestrator uses recent messages as context for each turn.

If the orchestrator needs more detail, a question appears above the composer. Press **Ctrl+Q**, type your answer, and press **Enter**.

## Approve agents

When the orchestrator wants to start an agent on your machine, you see a **Spawn** line with the task, model, and estimated tokens. Press **Ctrl+P** to focus it, use **↑ ↓** to choose if there are several, then press **Y** to approve or **N** to decline. Keep chat open on the machine running the worker and enable an installed agent CLI in settings.

To approve automatically, set **Spawn approval** to **Automatic** in settings. Your [limits](policies.md) apply either way.

The **Agents** panel on the right lists each task with its worker, status, and tokens. A tilde (`~40k`) marks an estimate until the worker reports real usage.

## Review pull requests

When a worker finishes code changes, clqn commits them on the task's own branch, pushes, opens a pull request, and posts the link in chat. Press **Ctrl+L** to see pull requests. The clan leader reviews the PR on GitHub, then presses **Y** to approve the merge or **N** to decline. clqn merges once the GitHub checks pass. See the [repository workflow](repositories.md).

## Keys

On macOS, use the **Ctrl** keys: function keys usually control brightness and volume unless you hold **fn**.

| Key | Action |
| --- | --- |
| Enter | Send your message |
| Ctrl+P (F3, Tab) | Focus spawn approvals. **↑ ↓** to choose, **Y** approve, **N** decline, **Esc** back |
| Ctrl+Q (F4) | Reply to the orchestrator's question. Press again to pick another question |
| Ctrl+L (F6) | Pull requests. The leader presses **Y** to approve a merge or **N** to decline |
| Ctrl+S (F2) | Settings |
| Ctrl+G (F5) | Metrics. **T** or **Tab** switches between 24 hours and 7 days |
| ↑ ↓, Page Up, Page Down | Scroll chat history. **End** jumps back to the latest |
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
| Sign out | Revoke this computer's sign-in |

## Metrics

Press **Ctrl+G** for tokens and active agents over time, tokens by member and by task, and how long messages waited in the queue.

## How tokens are counted

A worker's tokens are its input, cache writes, and output, summed over the run. Cache reads are left out: each call resends the whole conversation, mostly from the prompt cache, so counting those reads would count the same context again on every call. For Codex, cached input is subtracted from input tokens.

Tokens are not dollars: cache writes and output cost more per token than plain input. Orchestrator runs are not counted.

While a task is queued or running, its estimate is reserved against your token limit. When the worker reports usage, the real count replaces the estimate. Finished work with no report counts at its estimate.
