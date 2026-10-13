import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** A local process guard, not a distributed lock. One authority per data directory. */
export function acquireAuthorityLock(dataDirectory: string): () => void {
  const root = resolve(dataDirectory);
  mkdirSync(root, { recursive: true });
  const lockDirectory = resolve(root, ".authority-lock");
  const ownerFile = resolve(lockDirectory, "owner.json");
  const instance = randomUUID();
  // Serialize stale-owner recovery too: two starters must never delete each other's new lock.
  const startingDirectory = resolve(root, ".authority-starting");
  try { mkdirSync(startingDirectory); }
  catch { throw new Error("Another authority is starting, or its startup was interrupted; verify before recovering the startup guard."); }
  try {
  if (existsSync(lockDirectory)) {
    let owner: { pid: number; instance: string };
    try { owner = JSON.parse(readFileSync(ownerFile, "utf8")); }
    catch { throw new Error("Authority lock is incomplete; verify no authority is starting before recovering it."); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.instance !== "string") throw new Error("Invalid authority lock; manual verification required.");
    let running = true;
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") running = false;
      else throw new Error("Cannot verify the existing authority process; refusing a second writer.");
    }
    if (running) throw new Error("An authority already owns this data directory.");
    // Remove only the exact known owner file and empty lock directory, never a recursive tree.
    unlinkSync(ownerFile);
    rmdirSync(lockDirectory);
  }
  mkdirSync(lockDirectory);
  writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, instance }), { flag: "wx", mode: 0o600 });
  } finally { rmdirSync(startingDirectory); }
  return () => {
    try {
      const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as { instance: string };
      if (owner.instance === instance) { unlinkSync(ownerFile); rmdirSync(lockDirectory); }
    } catch { /* Never remove a replacement or unfamiliar lock. */ }
  };
}
