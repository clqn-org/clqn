# clqn — Roadmap

Type `clqn`, and a chat opens in your terminal. You talk to one orchestrator agent, and it gets the work done using your team's agents. Tasks, branches, and agents all happen behind the scenes.

## How it works

1. **Type `clqn`.** A full-screen chat opens. Everything happens here.
2. **Join with one keypress.** If you're invited to a clan, the invite shows up. Accept it right there.
3. **Message the orchestrator.** Everyone in the clan talks to the same orchestrator, which runs on the leader's machine. Messages wait in a queue and get handled in order.
4. **The orchestrator splits up the work.** It turns requests into tasks and picks who should do each one. You never manage tasks yourself.
5. **You say yes or no.** When the orchestrator wants to start an agent on your machine, you get asked. Type `y` or `n`. It never goes over your limits.
6. **Watch it happen.** A sidebar shows who's working, task progress, and tokens used over time.
7. **Your `main` stays current.** When `main` changes on GitHub, your local copy updates by itself, but only if you have no uncommitted changes.

## Member limits

Each member sets their own:

- **Token limit:** total tokens their agents can use
- **Agent count:** how many agents can run on their machine at once
- **Models:** which models their agents are allowed to use

## What's done

- Sign in with GitHub, create a clan, and invite teammates by email
- Connect Claude Code or Codex to a clan
- Tasks with clear ownership: assign, claim, open a pull request, merge
- A shared clan chat that's saved on the server
- An orchestrator role (one per clan, belongs to the leader)
- Token and model limits are saved (but not enforced yet)
- GitHub webhooks tell connected agents when `main` changes, and clean checkouts sync
- The API runs on Google Cloud (Cloud Run + PostgreSQL)

## What's next

In order:

1. **The chat screen.** `clqn` opens the full-screen chat with a sidebar. Andy's earlier version (commit `04006cc`) is a good starting point.
2. **Invites in the chat screen.** See and accept invites without leaving it.
3. **Message queue.** Messages to the orchestrator wait in line and get marked as queued, working, or done. Start with PostgreSQL, and move to Google Cloud Pub/Sub only if we need it.
4. **Orchestrator loop.** On the leader's machine, the orchestrator reads the queue, creates tasks, picks members, and replies in the chat.
5. **Yes/no approvals.** Each member's machine asks before starting an agent, then runs it in the background.
6. **Limits that work.** Add the agent count, and stop at each member's token, agent, and model limits.
7. **`main` sync in the chat screen.** Link the repo during setup, and keep `main` synced while `clqn` is open.
8. **Live sidebar.** Show active agents, task status, and a tokens-over-time graph.

## Later

- **Turn `main` protection back on.** It's off for now so we can push and force-push straight to `main` while building the basics. Turn the branch protection rules back on before the first real release.
- **Terminal too small.** If the window can't fit the chat screen, show "Please make your terminal bigger" until it fits.

## Ground rules

- **Your machine, your call.** Nothing runs on your computer without your "yes".
- **Hide the plumbing.** People chat and approve. Tasks, branches, and agents are the orchestrator's job.
- **Keep it simple.** Small working steps, few dependencies, minimal cloud setup.
- **Chat isn't a command.** Treat messages as untrusted. Only approved tasks lead to real work.
- **Never touch your work.** Only sync a clean `main`. Never rebase, reset, or stash your changes.
- **Secrets stay on the server**, and everything is scoped to its clan.
