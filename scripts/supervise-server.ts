import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

let child: ChildProcess | undefined;
let stopping = false;
let failures = 0;
let timer: NodeJS.Timeout | undefined;

function start(): void {
  const startedAt = Date.now();
  child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("src/authoritative-server.ts")], {
    cwd: process.cwd(), env: process.env, stdio: "inherit", windowsHide: true
  });
  child.once("error", () => { process.stderr.write("Unable to start the authority process.\n"); });
  child.once("exit", (code) => {
    child = undefined;
    if (stopping) return;
    if (code === 0) return;
    if (Date.now() - startedAt > 60_000) failures = 0;
    failures += 1;
    if (failures > 5) {
      process.stderr.write("Authority repeatedly failed to start; stopped retrying. Check its last error before restarting.\n");
      process.exitCode = 1;
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** (failures - 1));
    process.stderr.write(`Authority stopped unexpectedly; restoring the same data directory in ${delay}ms.\n`);
    timer = setTimeout(start, delay);
  });
}

function stop(): void {
  stopping = true;
  if (timer) clearTimeout(timer);
  child?.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
start();
