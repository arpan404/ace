import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import { createPiAdapter } from "./index.ts";

test("cold native fork uses saved cwd, preserves source and never delivers input or MCP", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ace-pi-fork-"));
  const path = join(cwd, "source.jsonl");
  const source = JSON.stringify({ type: "session", version: 3, cwd }) + "\n";
  await writeFile(path, source);
  const adapter = createPiAdapter({
    cli: {
      installed: true,
      path: "synthetic-pi",
      version: "0.85.1",
      auth: "unknown",
      loginHint: "none",
    },
    openMcp() {
      throw new Error("A cold clone must not grant thread MCP authority");
    },
    runtime: {
      spawn: (options) =>
        spawnTextSupervised({
          ...options,
          command: process.execPath,
          env: { ...options.env, FAKE_PI_COLD_CWD: cwd },
          args: [
            fileURLToPath(new URL("./testing/fake-pi.ts", import.meta.url)),
            ...(options.args ?? []),
          ],
        }),
    },
  });
  try {
    expect(
      await adapter.forkSession({ nativeSessionId: path, signal: new AbortController().signal }),
    ).toBe("/synthetic/fork.jsonl");
    expect(await readFile(path, "utf8")).toBe(source);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unbounded or invalid native session headers fail before any cold process starts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ace-pi-header-"));
  const path = join(cwd, "source.jsonl");
  const adapter = createPiAdapter({
    runtime: {
      spawn() {
        throw new Error("must not launch");
      },
    },
  });
  const input = { nativeSessionId: path, signal: new AbortController().signal };
  try {
    await writeFile(path, "x".repeat(64 * 1024 + 1));
    await expect(adapter.forkSession(input)).rejects.toThrow("header");
    await writeFile(path, JSON.stringify({ type: "session", version: 3, cwd: "relative" }) + "\n");
    await expect(adapter.forkSession(input)).rejects.toThrow("absolute");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("cold forks reject excess concurrent work and release admission after failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ace-pi-fork-cap-"));
  const path = join(cwd, "source.jsonl");
  await writeFile(path, "invalid header\n");
  const adapter = createPiAdapter();
  const input = { nativeSessionId: path, signal: new AbortController().signal };
  try {
    // Header I/O cannot resolve before these synchronous public admissions finish.
    const first = Array.from({ length: 8 }, () => adapter.forkSession(input));
    const settled = Promise.allSettled(first);
    await expect(adapter.forkSession(input)).rejects.toThrow("capacity");
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    await writeFile(path, "x".repeat(64 * 1024 + 1));
    await expect(adapter.forkSession(input)).rejects.toThrow("header");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
