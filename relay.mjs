/**
 * Linear -> local Claude Code sessions.
 *
 * Assigning a Linear issue to the agent starts an interactive Claude Code session
 * on this Mac, inside its own git worktree, with Remote Control on — so the session
 * shows up in Claude Desktop, claude.ai/code and the mobile app and can be steered
 * from any of them. Replies on the Linear issue are typed into the running session.
 */
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LinearClient, LinearWebhooks } from "@linear/sdk";

const SIGNATURE_HEADER = "linear-signature";

const run = promisify(execFile);

const HOME = homedir();
const CONFIG_DIR = process.env.LINEAR_CLAUDE_HOME ?? join(HOME, ".linear-claude");
const PROMPTS = join(CONFIG_DIR, "prompts");
const LOG = join(CONFIG_DIR, "relay.log");
const MODELS = ["fable", "opus", "sonnet", "haiku"];

/** Blocks accidents an unattended session shouldn't have. Everything else asks you in the app. */
const DEFAULT_DISALLOWED_TOOLS = [
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
  "Bash(git push --force-with-lease:*)",
  "Bash(gh pr merge:*)",
  "Bash(gh repo delete:*)",
  "Bash(rm -rf:*)",
  "Bash(rm -fr:*)",
  "Read(~/.ssh/**)",
  "Edit(~/.ssh/**)",
];

const log = (message) => {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  appendFileSync(LOG, line);
};

const readEnvFile = (path) =>
  Object.fromEntries(
    readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

const env = { ...readEnvFile(join(CONFIG_DIR, ".env")), ...process.env };
for (const key of ["LINEAR_TOKEN", "LINEAR_WEBHOOK_SECRET", "REPO_PATH"]) {
  if (!env[key]) throw new Error(`Missing ${key} in ${join(CONFIG_DIR, ".env")}`);
}

const REPO = env.REPO_PATH;
const BASE_BRANCH = env.BASE_BRANCH ?? "origin/main";
const WORKTREES = env.WORKTREE_DIR ?? join(CONFIG_DIR, "worktrees");
const PORT = Number(env.PORT ?? 3456);
const DEFAULT_MODEL = env.DEFAULT_MODEL ?? "sonnet";
const DISALLOWED_TOOLS = env.DISALLOWED_TOOLS ? env.DISALLOWED_TOOLS.split(",") : DEFAULT_DISALLOWED_TOOLS;

const linear = new LinearClient({ accessToken: env.LINEAR_TOKEN });
const webhooks = new LinearWebhooks(env.LINEAR_WEBHOOK_SECRET);

mkdirSync(WORKTREES, { recursive: true });
mkdirSync(PROMPTS, { recursive: true });

const postActivity = async (agentSessionId, type, body) => {
  try {
    await linear.createAgentActivity({ agentSessionId, content: { type, body } });
  } catch (error) {
    log(`Failed to post ${type} activity: ${error.message}`);
  }
};

/** Model tag in the issue description wins; otherwise a model label; otherwise the default. */
const resolveModel = (description, labels) => {
  const tag = /\\?\[model=([a-z0-9.-]+)\\?\]/i.exec(description ?? "")?.[1]?.toLowerCase();
  if (tag && MODELS.includes(tag)) return tag;
  const label = (labels ?? []).map((name) => name.toLowerCase()).find((name) => MODELS.includes(name));
  return label ?? DEFAULT_MODEL;
};

const worktreeFor = async (slug) => {
  const path = join(WORKTREES, slug);
  if (existsSync(path)) return path;

  const [remote, branch] = BASE_BRANCH.split("/");
  await run("git", ["-C", REPO, "fetch", remote, branch]);
  await run("git", ["-C", REPO, "worktree", "add", "-b", `claude/${slug}`, path, BASE_BRANCH]);
  return path;
};

const buildPrompt = (issue, guidance) => `You are working on Linear issue ${issue.identifier}.

# ${issue.title}

${issue.description || "(no description)"}
${guidance ? `\nContext from Linear:\n${guidance}\n` : ""}
Link: ${issue.url}

You are in a git worktree of the repo, on branch claude/${issue.identifier.toLowerCase()}, branched from ${BASE_BRANCH}.
Follow the repo's CLAUDE.md and any rules it points to.

When the work is done: commit, push the branch, and open a PR against ${BASE_BRANCH.split("/").pop()} with \`gh\`.
Then post a short summary and the PR link as a comment on the Linear issue (${issue.url}).
If you can't reach Linear, say so in your final message instead.

The person who assigned this is watching in the Claude app and can reply at any time.`;

/** `tmux ls` exits non-zero when no server is running yet — that just means no sessions. */
const runningSessions = () => {
  try {
    return execFileSync("tmux", ["ls", "-F", "#S"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
};

const startSession = async (session) => {
  const issue = session.issue;
  const slug = issue.identifier.toLowerCase();
  const model = resolveModel(issue.description, (issue.labels ?? []).map((label) => label.name ?? label));

  if (runningSessions().includes(slug)) {
    await postActivity(session.id, "thought", `A session for ${issue.identifier} is already running.`);
    return;
  }

  const path = await worktreeFor(slug);
  const promptFile = join(PROMPTS, `${slug}.md`);
  writeFileSync(promptFile, buildPrompt(issue, session.guidance));

  // The prompt goes first: --disallowedTools is variadic and would otherwise swallow it.
  const command = [
    "claude",
    `"$(cat ${quote(promptFile)})"`,
    "--remote-control", quote(`${issue.identifier} ${issue.title}`),
    "--model", model,
    "--permission-mode", "acceptEdits",
    "--disallowedTools", quote(DISALLOWED_TOOLS.join(",")),
  ].join(" ");

  await run("tmux", ["new-session", "-d", "-s", slug, "-x", "200", "-y", "50", "-c", path, command]);
  log(`Started ${slug} (${model}) in ${path}`);

  const url = await waitForSessionUrl(slug);
  const where = url
    ? `Open it here: ${url}`
    : "It's running locally, but the session link didn't appear — check the Claude app.";
  await postActivity(session.id, "thought", `Started a local Claude Code session with ${model}. ${where}`);
};

/** The Remote Control banner prints the claude.ai session URL a few seconds after launch. */
const waitForSessionUrl = async (slug) => {
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const { stdout } = await run("tmux", ["capture-pane", "-p", "-t", slug]).catch(() => ({ stdout: "" }));
    const url = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/.exec(stdout)?.[0];
    if (url) return url;
  }
  return undefined;
};

const sendToSession = async (session, text) => {
  const slug = session.issue.identifier.toLowerCase();
  if (!runningSessions().includes(slug)) {
    await startSession(session);
    return;
  }

  await run("tmux", ["send-keys", "-t", slug, "-l", text]);
  await run("tmux", ["send-keys", "-t", slug, "Enter"]);
  log(`Forwarded a reply to ${slug}`);
};

const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

const handleEvent = async (payload) => {
  if (payload.type !== "AgentSessionEvent") return;

  const session = payload.agentSession;
  if (!session?.issue?.identifier) {
    log(`Ignoring ${payload.action} event without an issue`);
    return;
  }

  if (payload.action === "created") {
    await postActivity(session.id, "thought", "Starting a local Claude Code session…");
    await startSession(session);
    return;
  }

  if (payload.action === "prompted") {
    const text = payload.agentActivity?.content?.body;
    if (text) await sendToSession(session, text);
  }
};

createServer((request, response) => {
  if (request.method !== "POST" || !request.url.startsWith("/linear-webhook")) {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    const signature = request.headers[SIGNATURE_HEADER];
    let payload;
    try {
      payload = JSON.parse(body.toString());
      webhooks.verify(body, signature, payload.webhookTimestamp);
    } catch (error) {
      log(`Rejected webhook: ${error.message}`);
      response.writeHead(401).end();
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    handleEvent(payload).catch((error) => log(`Event failed: ${error.stack ?? error.message}`));
  });
}).listen(PORT, () => log(`Relay listening on ${PORT}, repo ${REPO}`));
