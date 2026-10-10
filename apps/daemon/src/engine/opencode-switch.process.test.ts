import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { z } from "zod";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { ThreadId } from "@ace/protocol";
import { harness, scriptFrames } from "./test-support.ts";

test("an OpenCode model switch uses the selected model on the next input and preserves native history", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-opencode-switch-"));
  const executable = fileURLToPath(
    new URL("../../../../packages/adapter-opencode/src/testing/cli-v2.mjs", import.meta.url),
  );
  let origin = "",
    authorization = "";
  const adapter = createOpenCodeAdapter({
    discovery: {
      overrides: { opencode: executable },
      env: { HOME: home, ACE_TEST_COMPLETE_INPUT: "1" },
    },
    runtime: {
      fetch: (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        origin = url.origin;
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return fetch(input, init);
      },
    },
  });
  // Keep the fixture's in-memory provider history alive across engine idle-close.
  const keeper = await adapter.openSession({
    threadId: ThreadId.parse("keeper"),
    cwd: home,
    model: "opencode-go/muse-spark-1.3-contributor",
    signal: new AbortController().signal,
    onFrame: () => {},
    onExit: () => {},
  });
  let completed = Promise.withResolvers<void>();
  const h = await harness([], scriptFrames(), {
    provider: "opencode",
    idleMs: 500,
    discovery: { installed: true, auth: "logged_in", loginHint: "unused", version: "2.0.22" },
    nativeAdapter: {
      ...adapter,
      openSession: (ctx) =>
        adapter.openSession({
          ...ctx,
          onFrame: async (frame) => {
            await ctx.onFrame(frame);
            if (
              frame.channel === "sse" &&
              z.object({ type: z.literal("session.execution.succeeded") }).safeParse(frame.data)
                .success
            )
              completed.resolve();
          },
        }),
    },
  });
  try {
    expect(
      h.command({
        type: "thread.create",
        workspaceId: h.workspace,
        provider: "opencode",
        model: "opencode-go/muse-spark-1.3-contributor",
        input: [{ type: "text", text: "first synthetic input" }],
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    await completed.promise;
    await h.engine.flush();
    const thread = h.store.listThreads()[0];
    if (!thread) throw new Error("Missing thread");
    expect(
      h.command({
        type: "thread.switch",
        threadId: thread.id,
        selection: { provider: "opencode", model: "opencode-go/another-model" },
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.store.getThread(thread.id)?.switch?.state).toBe("applied");
    completed = Promise.withResolvers<void>();
    expect(
      h.command({
        type: "thread.send",
        threadId: thread.id,
        input: [{ type: "text", text: "next synthetic input" }],
        delivery: "queue",
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    await completed.promise;
    await h.engine.flush();
    expect(h.contexts).toHaveLength(1);
    // Model selection is native and keeps the live session. Exercise resume separately
    // after an actual engine idle-close, with the keeper preserving provider history.
    h.clock.advance(h.clock.now() + 501);
    await h.engine.flush();
    completed = Promise.withResolvers<void>();
    expect(
      h.command({
        type: "thread.send",
        threadId: thread.id,
        input: [{ type: "text", text: "synthetic input after idle" }],
        delivery: "queue",
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    await completed.promise;
    await h.engine.flush();
    const requests = z
      .array(z.object({ path: z.string(), method: z.string(), modelUsed: z.unknown().optional() }))
      .parse(
        await (
          await fetch(new URL("/test/requests", origin), { headers: { authorization } })
        ).json(),
      );
    const prompts = requests.filter((request) => request.path.endsWith("/prompt"));
    expect(prompts.map((request) => request.modelUsed)).toEqual([
      { providerID: "opencode-go", id: "muse-spark-1.3-contributor" },
      { providerID: "opencode-go", id: "another-model" },
      { providerID: "opencode-go", id: "another-model" },
    ]);
    expect(prompts[0]?.path).toBe(prompts[1]?.path);
    expect(prompts[1]?.path).toBe(prompts[2]?.path);
    expect(
      requests.filter((request) => request.path === "/api/session" && request.method === "POST"),
    ).toHaveLength(2); // keeper + one thread
    expect(h.contexts[1]?.resume?.nativeSessionId).toBe(prompts[0]?.path.split("/")[3]);
    expect(h.errors).toEqual([]);
  } finally {
    await h.close();
    await keeper.close("shutdown");
    await adapter.close();
    await rm(home, { recursive: true, force: true });
  }
});
