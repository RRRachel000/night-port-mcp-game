import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const operation = args.shift();
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || !args[i + 1]) throw new Error("Invalid arguments");
    flags.set(args[i]!.slice(2), args[i + 1]!);
  }
  const connectionFile = flags.get("connection-file");
  if (!connectionFile || !["state", "submit"].includes(operation ?? "")) throw new Error("Connection and operation are required");
  const connection = JSON.parse(readFileSync(connectionFile, "utf8")) as { localMcpUrl?: string; mcpUrl?: string; bearerToken?: string };
  const url = new URL(connection.mcpUrl ?? connection.localMcpUrl ?? "");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS or the local authority");
  const client = new Client({ name: "night-port-window-player", version: "0.2.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, connection.bearerToken ? { requestInit: { headers: { authorization: `Bearer ${connection.bearerToken}` } } } : {}));
    const input = operation === "submit" ? JSON.parse(readFileSync(flags.get("action-file") ?? "", "utf8")) : {};
    const result = await client.callTool({ name: operation === "state" ? "my_state" : "submit_action", arguments: input });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === "text")?.text;
    if (!text) throw new Error("Missing MCP result");
    // Own-seat private information goes only to this player's tool session, never the dispatcher.
    process.stdout.write(text + "\n");
    if (result.isError) process.exitCode = 1;
  } finally { await client.close().catch(() => undefined); }
}

main().catch(() => {
  process.stderr.write("Player connection unavailable. No action is confirmed; recover this seat connection and read my_state before retrying.\n");
  process.exitCode = 1;
});
