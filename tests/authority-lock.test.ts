import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { acquireAuthorityLock } from "../src/authority-lock.js";

test("authority guard refuses a second writer and releases only its own lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "night-port-lock-"));
  try {
    const release = acquireAuthorityLock(dir);
    assert.throws(() => acquireAuthorityLock(dir), /already owns/);
    release();
    assert.equal(existsSync(join(dir, ".authority-lock")), false);
    const nextRelease = acquireAuthorityLock(dir);
    release();
    assert.equal(existsSync(join(dir, ".authority-lock")), true);
    nextRelease();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an incomplete lock fails closed instead of deleting unknown state", () => {
  const dir = mkdtempSync(join(tmpdir(), "night-port-lock-incomplete-"));
  try {
    mkdirSync(join(dir, ".authority-lock"));
    writeFileSync(join(dir, ".authority-lock", "unfamiliar.txt"), "preserve");
    assert.throws(() => acquireAuthorityLock(dir), /incomplete/);
    assert.equal(existsSync(join(dir, ".authority-lock", "unfamiliar.txt")), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
