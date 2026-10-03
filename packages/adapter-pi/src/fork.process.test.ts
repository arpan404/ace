import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import { createPiAdapter, type PiOptions } from "./index.ts";
import { ThreadId } from "@ace/protocol";
import { sessionFixture } from "./testing/native-history.ts";

test.each([1, 3])(
  "v%s cold native fork uses saved cwd, preserves source and never delivers input or MCP",
  async (version) => {
    const cwd = await mkdtemp(join(tmpdir(), "ace-pi-fork-"));
    const path = join(cwd, "source.jsonl");
    const source = sessionFixture(cwd, "native", version === 1 ? undefined : version);
    await writeFile(path, source);
    const adapterOptions: PiOptions = {
      cli: {
        installed: true,
        path: "synthetic-pi",
        version: "0.85.1",
        auth: "unknown",
        loginHint: "none",
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
    };
    const adapter = createPiAdapter({
      ...adapterOptions,
      openMcp() {
        throw new Error("A cold clone must not grant thread MCP authority");
      },
    });
    try {
      const nativeSessionId = await adapter.forkSession({
        nativeSessionId: path,
        signal: new AbortController().signal,
      });
      const reopened = await createPiAdapter(adapterOptions).openSession({
        threadId: ThreadId.parse("cold-fork-reopen"),
        cwd,
        signal: new AbortController().signal,
        resume: { nativeSessionId },
        onFrame() {},
        onExit() {},
      });
      try {
        expect(reopened.nativeSessionFile).toBe(join(cwd, "fork.jsonl"));
      } finally {
        await reopened.close("idle");
      }
      expect(await readFile(join(cwd, "fork.jsonl"), "utf8")).toContain("abandoned answer");
      expect(await readFile(path, "utf8")).toBe(source);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

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
    await expect(adapter.forkSession(input)).rejects.toThrow("header");
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
