import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { createClaudeAdapter } from "@ace/adapter-claude";
import type { Frame, ProviderAdapter } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import { harness, scriptFrames } from "./test-support.ts";

/*
 * The real Claude adapter drives the synthetic Claude CLI, which holds a `now` message until its
 * running foreground Bash call returns, as Claude Code does. No model or installed CLI is used.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The real adapter on the fake CLI, recording every frame it reports. */
async function fakeClaude() {
  const directory = await mkdtemp(join(tmpdir(), "ace-claude-steer-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "claude");
  const script = fileURLToPath(
    new URL("../../../../packages/adapter-claude/src/testing/cli.ts", import.meta.url),
  );
  await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(executable, 0o755);
  const real = createClaudeAdapter({ executable, env: { HOME: directory } });
  const frames: Frame[] = [];
  const adapter: ProviderAdapter = {
    ...real,
    openSession: (ctx) =>
      real.openSession({
        ...ctx,
        onFrame: (frame) => {
          frames.push(frame);
          return ctx.onFrame(frame);
        },
      }),
  };
  return { adapter, frames };
}

const record = (frame: Frame): Record<string, unknown> =>
  typeof frame.data === "object" && frame.data !== null
    ? (frame.data as Record<string, unknown>)
    : {};
const mentions = (frame: Frame, text: string) => JSON.stringify(frame.data).includes(text);

test("an agent's steer during a long Claude command goes in at the command's boundary, inside the same turn", async () => {
  const { adapter, frames } = await fakeClaude();
  const h = await harness([], scriptFrames(), {
    provider: "claude",
    nativeAdapter: adapter,
    discovery: { installed: true, auth: "logged_in", loginHint: "", version: "2.1.312" },
  });
  cleanups.push(() => h.close());
  const id: ThreadId = await h.create("foreground-brief");
  await expect
    .poll(() => frames.some((frame) => mentions(frame, "brief-tool")), { timeout: 10_000 })
    .toBe(true);
  const sent = h.internalCommand(
    {
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "Use the cached build" }],
      delivery: "steer",
      trigger: "parent_agent",
    },
    "agent-steer",
  );
  expect(sent.ok).toBe(true);
  await h.engine.flush();
  // Handed to Claude at once, which holds it behind the running command: it leaves the queue.
  await expect
    .poll(
      () =>
        frames.some(
          (frame) => record(frame)["subtype"] === "fake_held" && mentions(frame, "cached build"),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  expect(h.engine.queue(id).messages).toEqual([]);

  await expect
    .poll(() => frames.some((frame) => record(frame)["type"] === "result"), { timeout: 10_000 })
    .toBe(true);
  await h.engine.flush();
  const order = (predicate: (frame: Frame) => boolean) => frames.findIndex(predicate);
  const returned = order((frame) => mentions(frame, "tool_result"));
  const taken = order(
    (frame) => record(frame)["subtype"] === "fake_input" && mentions(frame, "cached build"),
  );
  const ended = order((frame) => record(frame)["type"] === "result");
  // The turn took it when the command returned, before that turn ended.
  expect(returned).toBeGreaterThan(-1);
  expect(taken).toBeGreaterThan(returned);
  expect(taken).toBeLessThan(ended);
  // An agent's steer never moves the command to the background or interrupts the turn.
  const controls = frames
    .filter((frame) => frame.dir === "send" && record(frame)["type"] === "control_request")
    .map((frame) => (record(frame)["request"] as Record<string, unknown>)["subtype"]);
  expect(controls).not.toContain("background_tasks");
  expect(controls).not.toContain("interrupt");
  // The transcript holds the message once, still marked as the agent's.
  const bubbles = Object.values(h.store.snapshotThread(id).items).filter(
    (item) =>
      item.type === "message" &&
      item.role === "user" &&
      item.parts.some((part) => part.type === "text" && part.text === "Use the cached build"),
  );
  expect(bubbles).toMatchObject([{ origin: { kind: "parent_agent" } }]);
});
