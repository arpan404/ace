import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import { createPiAdapter, type PiOptions } from "./index.ts";
import type { Frame } from "@ace/engine-api";
import { obj, str, list } from "./native.ts";
import { ThreadId } from "@ace/protocol";
import { sessionFixture } from "./testing/native-history.ts";

test.each([1, 3] as const)(
  "v%s cold native fork preserves context without input or MCP",
  async (version) => {
    const cwd = await mkdtemp(join(tmpdir(), "ace-pi-fork-"));
    const path = join(cwd, "source.jsonl");
    const source = sessionFixture(cwd, "native", version === 1 ? undefined : version);
    await writeFile(path, source);
    const adapterOptions: PiOptions = {
      sessionReferenceDir: join(cwd, "references"),
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
            env: { ...options.env, FAKE_PI_COLD_CWD: cwd, FAKE_PI_HOME: cwd },
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
      const frames: Frame[] = [];
      const completedWrite = Promise.withResolvers<Frame>();
      const reopened = await createPiAdapter(adapterOptions).openSession({
        threadId: ThreadId.parse("cold-fork-reopen"),
        cwd,
        signal: new AbortController().signal,
        resume: { nativeSessionId },
        onFrame(frame) {
          frames.push(frame);
          const event = obj(frame.data);
          if (frame.dir !== "recv") return;
          if (event.type === "tool_execution_end" && event.toolName === "write")
            completedWrite.resolve(frame);
        },
        onExit() {},
      });
      try {
        expect(reopened.nativeSessionFile).toBe(join(cwd, "fork.jsonl"));
        await reopened.send([{ type: "text", text: "context-proof" }], "queue");
        const final = frames.findLast(
          (frame) => frame.dir === "recv" && obj(frame.data).type === "message_end",
        );
        expect(
          list(obj(obj(final?.data).message).content)
            .map((block) => str(obj(block).text))
            .join(""),
        ).toBe("first question|first answer|second question|abandoned answer");
        await reopened.send([{ type: "text", text: "write-proof" }], "queue");
        const toolProof = frames.findLast(
          (frame) => frame.dir === "recv" && obj(frame.data).type === "message_end",
        );
        expect(
          list(obj(obj(toolProof?.data).message).content)
            .map((block) => str(obj(block).text))
            .join(""),
        ).toBe("write available");
        const written = join(cwd, "approved.txt");
        await reopened.send([{ type: "text", text: "gated-write" }], "queue");
        expect(obj((await completedWrite.promise).data).isError).toBe(false);
        expect(await readFile(written, "utf8")).toBe("approved");
      } finally {
        await reopened.close("idle");
      }
      expect(await readFile(join(cwd, "fork.jsonl"), "utf8")).toContain("abandoned answer");
      // Native v1 migration owns the rewrite; conversation continuity is the contract.
      if (version === 3) expect(await readFile(path, "utf8")).toBe(source);
      const sourceFrames: Frame[] = [];
      const original = await createPiAdapter(adapterOptions).openSession({
        threadId: ThreadId.parse("cold-source-reopen"),
        cwd,
        signal: new AbortController().signal,
        resume: { nativeSessionId: path },
        onFrame(frame) {
          sourceFrames.push(frame);
        },
        onExit() {},
      });
      try {
        await original.send([{ type: "text", text: "context-proof" }], "queue");
        const final = sourceFrames.findLast(
          (frame) => frame.dir === "recv" && obj(frame.data).type === "message_end",
        );
        expect(
          list(obj(obj(final?.data).message).content)
            .map((block) => str(obj(block).text))
            .join(""),
        ).toBe("first question|first answer|second question|abandoned answer");
      } finally {
        await original.close("idle");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("unbounded or invalid native session headers fail before any cold process starts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ace-pi-header-"));
  const path = join(cwd, "source.jsonl");
  const adapter = createPiAdapter({
    sessionReferenceDir: join(cwd, "references"),
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
    await writeFile(
      path,
      JSON.stringify({ type: "session", version: 3, id: "valid-id", cwd: "relative" }) + "\n",
    );
    await expect(adapter.forkSession(input)).rejects.toThrow("header");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("cold forks reject excess concurrent work and release admission after failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ace-pi-fork-cap-"));
  const path = join(cwd, "source.jsonl");
  await writeFile(path, "invalid header\n");
  const adapter = createPiAdapter({ sessionReferenceDir: join(cwd, "references") });
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
