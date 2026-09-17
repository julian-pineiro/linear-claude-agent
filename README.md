# linear-claude-agent

Assign a Linear issue to Claude and a real Claude Code session starts on your own machine —
one you can open and steer from Claude Desktop, claude.ai/code or your phone.

Claude Code has no native Linear integration. The hosted alternatives run an agent SDK loop you
can't see or take over, and bill through an API key. This runs the actual `claude` CLI with
[Remote Control](https://code.claude.com/docs/en/remote-control) on, so the work happens on your
machine, on your Claude subscription, in a session you can jump into mid-task.

## What happens when you assign an issue

1. Linear sends an agent session webhook to a small relay on your machine.
2. The relay makes a git worktree for the issue, on branch `claude/<issue>`.
3. It starts `claude` in `tmux` with the issue as the prompt and Remote Control on.
4. The `claude.ai/code` link is posted back on the Linear issue.
5. Replying on the issue types into the running session.
6. Claude commits, pushes and opens a PR, then comments the link.

Pick the model per issue with `[model=sonnet]` in the description, or a `haiku` / `sonnet` /
`opus` label. Edits inside the worktree are automatic; anything else asks you, in whichever app
you're watching from.

## Setup

Paste this into Claude Code from the repo you want the agent to work in:

```
Set this up for me: https://github.com/OWNER/linear-claude-agent/blob/main/SETUP.md
Read that file and follow it step by step. Ask me for anything only I can do.
```

It takes about ten minutes, most of it yours: creating an ngrok account and a Linear OAuth app.
To do it by hand, follow [SETUP.md](SETUP.md) yourself.

## Requirements

- macOS (Linux works except the launchd services — use systemd user units)
- Claude Code, logged in with `claude auth login` on a Pro or Max plan.
  Remote Control does not work with an API key or a `setup-token` token
- Node 18+, `git`, `tmux`, `gh`
- A Linear workspace you're an admin of
- A public HTTPS URL that doesn't change (ngrok's free permanent domain is enough)

## Files

| | |
|---|---|
| `relay.mjs` | the webhook server: verifies Linear's signature, starts and feeds sessions |
| `scripts/authorize.mjs` | one-off OAuth flow to get the app token |
| `scripts/install-services.sh` | launchd services for the relay and the tunnel |
| `.env.example` | configuration |

## Worth knowing

- **Sessions run only while your Mac is awake and logged in.** Nothing runs in the cloud.
- **Shell access is not sandboxed.** A session can reach anything your user can. `DISALLOWED_TOOLS`
  blocks accidents, not a determined attempt; issue text is effectively a prompt, so only let
  people you trust assign to the agent.
- **Pro limits are shared** with your own Claude Code use. Several issues at once will exhaust
  a 5-hour window quickly.
- **Worktrees accumulate.** Remove one with `git -C <repo> worktree remove <path>`.
- **Claude can only comment on Linear if the Linear MCP connector is authorized** in the CLI
  (`/mcp`). The relay's own notes post regardless.

## License

MIT
