# Agent limits

Nothing runs on your machine without your say. When you create or join a clan, choose **Full access** (no limits) or **Custom**. Change your limits any time in settings (**Ctrl+S**).

| Limit | What it caps |
| --- | --- |
| Token limit | Total tokens your agents can use in this clan. See [how tokens are counted](chat.md#how-tokens-are-counted) |
| Agent limit | How many of your agents can run at once |
| Models | Which model IDs your agents may use. Blank allows any |

clqn checks your limits before every task. A queued or running task holds its estimated tokens and an agent slot until it finishes. The token limit counts all of your agents' usage in the clan and never resets. If the orchestrator doesn't pick a model and you've limited models, the worker uses the first one in your list.

Spawn approval is **Manual** by default, so you approve each agent before it starts. With **Automatic**, tasks that fit your limits start without asking.

Settings also choose which installed agents (Claude Code, Codex) to offer and what commands workers may run. See [settings](chat.md#settings).
