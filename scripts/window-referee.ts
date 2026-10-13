import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { playerConnectionFile } from "../src/window-paths.js";

const args = process.argv.slice(2);
const operation = args.shift();
const flags = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || args[i + 1] === undefined) throw new Error("Options must be --name value pairs.");
  flags.set(args[i]!.slice(2), args[i + 1]!);
}
function required(name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

async function main(): Promise<void> {
  if (!operation || !["list", "bind", "takeover", "claim", "sent", "failed", "pause", "resume", "status"].includes(operation)) {
    process.stdout.write("Usage: window-referee <list|bind|takeover|claim|sent|failed|pause|resume|status> [--game <id>] [--player <id> --thread <id> --kind codex|chatgpt|manual --host local] [--job <id> --dispatch <id> --failure <code>]\n");
    return;
  }
  const gameId = operation === "list" ? "" : required("game");
  const baseUrl = process.env.NIGHT_PORT_AUTHORITY_URL ?? process.env.NIGHT_PORT_LOCAL_URL ?? "http://127.0.0.1:3188";
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) throw new Error("Use HTTPS or the local authority.");
  const operatorKey = readFileSync(resolve(process.env.NIGHT_PORT_OPERATOR_KEY_FILE ?? ".local/operator.key"), "utf8").trim();
  let body: Record<string, unknown> = { operation, gameId };
  if (operation === "bind" || operation === "takeover") {
    body = { operation: "bind", gameId, takeover: operation === "takeover", route: {
      playerId: required("player"), threadId: required("thread"), hostId: flags.get("host") ?? "local", kind: flags.get("kind") ?? "codex"
    } };
  } else if (operation === "sent" || operation === "failed") {
    body = { operation: "report", gameId, jobId: required("job"), dispatchId: required("dispatch"),
      ...(operation === "failed" ? { failure: required("failure") } : {}) };
  } else if (operation === "pause" || operation === "resume") {
    body = { operation: "pause", gameId, paused: operation === "pause" };
  }
  const response = await fetch(new URL("/api/referee", base), {
    method: "POST", headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000)
  });
  const payload = await response.json() as { ok: boolean; result?: Record<string, unknown>; error?: unknown };
  if (!response.ok || !payload.ok) throw new Error(`Operator request failed (${response.status}): ${JSON.stringify(payload.error)}`);
  if (operation === "bind" || operation === "takeover") {
    const key = payload.result!.key as string;
    const output = playerConnectionFile(gameId, required("player"));
    const remoteBase = flags.get("remote-base");
    const localMcpUrl = new URL(`/mcp/seat/${key}`, base).href;
    // Keep connection capabilities in private files, never in terminal/chat output.
    const config = { gameId, playerId: required("player"), generation: payload.result!.generation, localMcpUrl,
      ...(remoteBase === undefined ? {} : { remoteMcpUrl: new URL(`/mcp/seat/${key}`, remoteBase).href }) };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(`${output}.tmp`, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${output}.tmp`, output);
    process.stdout.write(JSON.stringify({ ok: true, gameId, playerId: config.playerId, generation: config.generation, connectionFile: output }) + "\n");
  } else {
    process.stdout.write(JSON.stringify(payload) + "\n");
  }
}

main().catch(() => {
  // Network/client error objects can contain request headers or credential-bearing URLs.
  process.stderr.write("Window referee request failed. Check local authority availability, operator key file and command arguments; no unconfirmed action should be replayed blindly.\n");
  process.exitCode = 1;
});
