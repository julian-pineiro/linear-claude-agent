# Setup playbook

Instructions for a coding agent (Claude Code) setting this up on someone's machine.
Work through the steps in order. Stop and ask whenever a step is the person's to do.

macOS is covered end to end. On Linux, everything works except the launchd services —
use systemd user units instead.

## 1. Check what's already there

```bash
for t in node npm git gh tmux claude ngrok; do printf "%s: " $t; command -v $t || echo MISSING; done
claude auth status
```

- Node 18+, `git`, `tmux`, `gh` (logged in) and `claude` are required.
- `claude auth status` must show `"loggedIn": true` with `"authMethod": "claude.ai"`.
  Remote Control does not work with an API key or a `setup-token` token. If it isn't logged in,
  ask the person to run `claude auth login` themselves — it opens a browser.
- Install anything missing with `brew install tmux` etc. Ask first.

## 2. Get a public HTTPS URL (person's step)

Linear must reach the relay, and the URL has to stay the same, because it's registered in
the Linear app.

Ask the person to sign up at [ngrok.com](https://ngrok.com), then:

```bash
ngrok config add-authtoken <their-token>
```

They get one free permanent domain at [dashboard.ngrok.com/domains](https://dashboard.ngrok.com/domains).
Ask for the domain; it isn't a secret. A Cloudflare Tunnel or any public HTTPS host works too.

**Never ask for the authtoken itself, and never type it for them.**

## 3. Create the Linear app (person's step)

They must be a Linear workspace admin. Tell them to open
Settings → API → OAuth Applications → **New** and fill in:

| Field | Value |
|---|---|
| Name | what they want to assign issues to, e.g. `Claude` |
| Callback URL | `https://<their-domain>/callback` |
| Webhook URL | `https://<their-domain>/linear-webhook` |
| Client credentials | on |
| Webhooks | on |
| Webhook events | **Agent session events** (required), Inbox notifications, Permission changes |

Saving gives a **Client ID**, a **Client secret** and a **Webhook signing secret**.

## 4. Install the relay

```bash
git clone https://github.com/julian-pineiro/linear-claude-agent.git ~/.linear-claude
npm --prefix ~/.linear-claude install
mkdir -p ~/.linear-claude/prompts
```

Use `npm --prefix`, not `cd && npm install`: a plain `npm install` in the wrong directory
writes a `package.json` into the person's home folder.

## 5. Write the config

```bash
cp ~/.linear-claude/.env.example ~/.linear-claude/.env
chmod 600 ~/.linear-claude/.env
```

Fill in `REPO_PATH` (the repo Claude should work in) and `BASE_BRANCH` yourself.
`LINEAR_WEBHOOK_SECRET` and `LINEAR_TOKEN` are secrets: have the person paste them into
the file with `nano ~/.linear-claude/.env`. Don't ask them to paste secrets into the chat,
and check the result by counting characters, not by printing values:

```bash
awk -F= '{printf "%s -> %d chars\n", $1, length(substr($0,index($0,"=")+1))}' ~/.linear-claude/.env
```

TextEdit rewrites quotes and can save elsewhere; `nano` avoids both problems.

## 6. Get the Linear token

`LINEAR_TOKEN` is an app token acting as the agent, obtained with the OAuth flow using
`actor=app`. The simplest path is the helper in this repo:

```bash
node ~/.linear-claude/scripts/authorize.mjs
```

It starts a temporary server on the relay port, opens Linear's consent page, exchanges the
code and prints the token, which the person pastes into `.env`. The relay must not be running
during this step, or the port is taken.

## 7. Start it

```bash
bash ~/.linear-claude/scripts/install-services.sh
```

This writes two launchd agents — the relay and the ngrok tunnel — and starts them. They come
back at login and restart if they crash. It asks for the ngrok domain if `.env` doesn't have it.

Check:

```bash
launchctl list | grep linear-claude
curl -s -o /dev/null -w "%{http_code}\n" -X POST -d '{}' https://<domain>/linear-webhook   # expect 401
```

401 on an unsigned request is correct: the relay rejects anything Linear didn't sign.

## 8. Test end to end

Ask the person to create a small Linear issue and assign it to the agent. Within a few
seconds the issue should get a comment with a `claude.ai/code` link, and:

```bash
tmux ls                 # a session named after the issue
tail -f ~/.linear-claude/relay.log
```

If nothing happens, check in this order:

1. `tail ~/.linear-claude/relay.log` — signature rejections mean the webhook secret is wrong.
2. `tail ~/.linear-claude/ngrok.log` — the tunnel may be down or the domain wrong.
3. Linear's app page shows recent webhook deliveries and their response codes.
4. `tmux attach -t <issue>` — the session may be asking something.

## 9. Tell them how it works

- Assign an issue to see a session start; open it in Claude Desktop, claude.ai/code or the phone app.
- Replying on the Linear issue types into the running session.
- Model per issue: `[model=sonnet]` in the description, or a `haiku`/`sonnet`/`opus` label.
- Each issue gets a worktree in `WORKTREE_DIR`, on branch `claude/<issue>`.
- Edits inside the worktree are automatic; anything else asks them in the app.
- Sessions only run while the Mac is awake and logged in.
- Worktrees pile up. Remove one with `git -C <repo> worktree remove <path>`.
