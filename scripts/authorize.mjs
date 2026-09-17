/**
 * One-off Linear OAuth flow for the agent app.
 *
 * Opens Linear's consent page, catches the redirect on the relay's own public URL, and
 * exchanges the code for an app token (`actor=app`) to put in .env as LINEAR_TOKEN.
 * The relay must be stopped while this runs — it needs the same port.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

const CONFIG_DIR = process.env.LINEAR_CLAUDE_HOME ?? join(homedir(), ".linear-claude");

const env = Object.fromEntries(
  readFileSync(join(CONFIG_DIR, ".env"), "utf-8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

for (const key of ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "PUBLIC_URL"]) {
  if (!env[key]) throw new Error(`Missing ${key} in ${join(CONFIG_DIR, ".env")}`);
}

const port = Number(env.PORT ?? 3456);
const redirectUri = `${env.PUBLIC_URL}/callback`;
const scope = "write,app:assignable,app:mentionable";
const authorizeUrl =
  `https://linear.app/oauth/authorize?client_id=${env.LINEAR_CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&actor=app`;

const exchange = async (code) => {
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      redirect_uri: redirectUri,
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  return (await response.json()).access_token;
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, env.PUBLIC_URL);
  if (url.pathname !== "/callback") {
    response.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error || !code) {
    response.writeHead(400, { "Content-Type": "text/html" }).end(`<h2>Authorization failed</h2><p>${error ?? "no code"}</p>`);
    server.close();
    process.exitCode = 1;
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html" }).end("<h2>Authorized</h2><p>Back to the terminal.</p>");

  const token = await exchange(code);
  console.log(`\nPaste this into ${join(CONFIG_DIR, ".env")} as LINEAR_TOKEN:\n\n${token}\n`);
  server.close();
});

server.listen(port, () => {
  console.log(`Waiting for Linear on ${redirectUri}\nIf the browser doesn't open, visit:\n${authorizeUrl}\n`);
  execFile("open", [authorizeUrl], () => {});
});
