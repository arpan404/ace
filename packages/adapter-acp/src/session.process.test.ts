import { fileURLToPath } from "node:url";
import { it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame, ProviderSession } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { openAcpSession } from "./index.ts";
import { createAcpAdapter } from "./index.ts";
import { cursorQuirks } from "./quirks/cursor.ts";
import { antigravityQuirks } from "./quirks/antigravity.ts";
import { genericQuirks } from "./quirks/generic.ts";
import { interactionKey } from "./interactions.ts";
import { nativeAgentKey } from "./keys.ts";
import { spawnSupervised } from "@ace/provider-kit/process";
import type { SessionRuntime } from "./index.ts";
import { object } from "./data.ts";
const fake = fileURLToPath(new URL("./testing/acp-server.ts", import.meta.url));
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function setup(quirks = cursorQuirks, resume = false, runtime?: SessionRuntime) {
  const home = await mkdtemp(join(tmpdir(), "ace-acp-session-"));
  homes.push(home);
  const frames: Frame[] = [];
  const inputMessages: { commandId: string; nativeId: string; beforeFrame: number }[] = [];
  const watchers = new Set<() => void>();
  const controller = new AbortController();
  const threadId = ThreadId.parse("session-test");
  const { promise: exited, resolve: exitResolve } = Promise.withResolvers<{
    deliberate: boolean;
  }>();
  const ctx = {
    threadId,
    cwd: home,
    env: { HOME: home },
    model: "test-model",
    signal: controller.signal,
    ...(resume ? { resume: { nativeSessionId: "native-root" } } : {}),
    onFrame(frame: Frame) {
      frames.push(frame);
      for (const watcher of watchers) watcher();
    },
    onExit: exitResolve,
    onInputMessage: (identity: { commandId: string; nativeId: string }) =>
      inputMessages.push({ ...identity, beforeFrame: frames.length }),
  };
  const session: ProviderSession =
    quirks === genericQuirks
      ? await createAcpAdapter(quirks, { command: process.execPath, args: [fake] }).openSession(ctx)
      : await openAcpSession(
          ctx,
          quirks,
          {
            command: process.execPath,
            args: [fake],
            version: quirks.provider === "cursor" ? "2026.09.26-test" : "1.2.1",
          },
          runtime,
        );
  function wait(predicate: (f: Frame) => boolean): Promise<Frame> {
    return new Promise((resolve) => {
      const check = () => {
        const found = frames.find(predicate);
        if (found) {
          watchers.delete(check);
          resolve(found);
        }
      };
      watchers.add(check);
      check();
    });
  }
  return { session, frames, inputMessages, controller, exited, wait };
}
const input = (text: string) => [{ type: "text" as const, text }];
const method = (f: Frame, name: string) => object(f.data)["method"] === name;
it("ACP fallback correlates ace input before the native prompt is logged", async () => {
  const h = await setup(genericQuirks);
  try {
    await h.session.send(input("user-echo"), "queue", "ace-wake", "ace");
    const identity = h.inputMessages[0];
    if (!identity) throw new Error("Missing ACP command correlation");
    expect(identity).toMatchObject({ commandId: "ace-wake", nativeId: "ace-wake" });
    expect(h.frames[identity.beforeFrame]).toMatchObject({
      dir: "note",
      data: { event: "input-sending", nativeId: "ace-wake" },
    });
    const translator = createAcpAdapter(genericQuirks, {
      command: process.execPath,
      args: [fake],
    }).createTranslator({ threadId: ThreadId.parse("session-test"), rootKey: "root" });
    const facts = h.frames.flatMap((frame) => translator.translate(frame, frame.t));
    expect(facts).toContainEqual(
      expect.objectContaining({
        type: "item.upsert",
        draft: expect.objectContaining({ type: "message", role: "user", nativeId: "ace-wake" }),
      }),
    );
    expect(
      facts.some((fact) => fact.type === "item.delta" && fact.append === "echoed context"),
    ).toBe(false);
    expect(facts).toContainEqual(
      expect.objectContaining({
        type: "item.upsert",
        draft: expect.objectContaining({
          type: "notice",
          text: "Delegated-agent context echoed by the provider.",
        }),
      }),
    );
    const after = h.frames.length;
    await h.session.send(input("user-echo"), "queue", "copied-user-command");
    const userFacts = h.frames
      .slice(after)
      .flatMap((frame) => translator.translate(frame, frame.t));
    expect(userFacts).toContainEqual(
      expect.objectContaining({ type: "item.delta", append: "echoed context" }),
    );
  } finally {
    await h.session.close("user");
  }
});
it("queues reprompts until the current turn settles and forwards extension responses", async () => {
  const h = await setup();
  try {
    const first = h.session.send(input("hold"), "steer");
    await h.wait((f) => method(f, "cursor/create_plan"));
    const second = h.session.send(input("next"), "queue");
    await h.wait((f) => method(f, "test/information-ack"));
    expect(h.frames.filter((f) => f.dir === "send" && method(f, "session/prompt"))).toHaveLength(1);
    await expect(
      h.session.resolve(interactionKey(100), { kind: "approval", optionId: "a" }),
    ).rejects.toThrow("kind");
    await h.session.resolve(interactionKey(100), {
      kind: "plan_review",
      decision: "reject",
      feedback: "No",
    });
    await Promise.all([first, second]);
    const answer = await h.wait((f) => method(f, "test/answer"));
    expect(object(answer.data)["params"]).toEqual({
      outcome: { outcome: "rejected", reason: "No" },
    });
    const unsupported = await h.wait((f) => method(f, "test/unknown-rejected"));
    expect(object(object(unsupported.data)["params"])["code"]).toBe(-32601);
    await expect(
      h.session.resolve(interactionKey(100), { kind: "plan_review", decision: "approve" }),
    ).rejects.toThrow("pending");
    expect(h.frames.filter((f) => f.dir === "send" && method(f, "session/prompt"))).toHaveLength(2);
  } finally {
    await h.session.close("user");
  }
});
it("holds queued prompts while a child remains live and sends cascade cancellation", async () => {
  const h = await setup();
  try {
    await h.session.send(input("child"), "queue");
    const next = h.session.send(input("next"), "queue");
    expect(h.frames.filter((f) => f.dir === "send" && method(f, "session/prompt"))).toHaveLength(1);
    await h.session.interrupt({ cascade: true });
    await next;
    expect(
      h.frames.some(
        (f) =>
          f.dir === "send" &&
          method(f, "session/cancel") &&
          object(object(f.data)["params"])["sessionId"] === "native-child",
      ),
    ).toBe(true);
  } finally {
    await h.session.close("user");
  }
});
it("cancels pending interactions when interrupted and rejects unsupported task control", async () => {
  const h = await setup();
  try {
    const active = h.session.send(input("hold"), "queue");
    await h.wait((f) => method(f, "cursor/create_plan"));
    await h.session.interrupt({ cascade: true });
    await active;
    expect(object((await h.wait((f) => method(f, "test/answer"))).data)["params"]).toEqual({
      outcome: { outcome: "cancelled" },
    });
    await expect(h.session.stopTask("task")).rejects.toThrow("control");
  } finally {
    await h.session.close("user");
  }
});
it("routes targeted cancellation by the translator's child key", async () => {
  const h = await setup();
  try {
    await h.session.send(input("child"), "queue");
    await h.session.interrupt({
      agent: nativeAgentKey("session-test", "native-child"),
      cascade: false,
    });
    expect(
      h.frames
        .filter((f) => f.dir === "send" && method(f, "session/cancel"))
        .map((f) => object(object(f.data)["params"])["sessionId"]),
    ).toEqual(["native-child"]);
    await expect(h.session.interrupt({ agent: "invalid", cascade: false })).rejects.toThrow(
      "Unknown",
    );
  } finally {
    await h.session.close("user");
  }
});
it("encodes Antigravity answers as permission option IDs", async () => {
  const h = await setup(antigravityQuirks);
  try {
    const active = h.session.send(input("permission"), "queue");
    await h.wait((f) => method(f, "session/request_permission"));
    await expect(
      h.session.resolve(interactionKey(100), {
        kind: "question",
        answers: { interaction_choice: ["bad"] },
      }),
    ).rejects.toThrow("Invalid");
    await h.session.resolve(interactionKey(100), {
      kind: "question",
      answers: { interaction_choice: ["a"] },
    });
    await active;
    expect(object((await h.wait((f) => method(f, "test/answer"))).data)["params"]).toEqual({
      outcome: { outcome: "selected", optionId: "a" },
    });
  } finally {
    await h.session.close("user");
  }
});
it("loads an existing native session and applies model selection before input", async () => {
  const h = await setup(cursorQuirks, true);
  try {
    expect(h.session.nativeSessionId).toBe("native-root");
    await h.session.send(input("ok"), "queue");
    expect(
      h.frames
        .filter((f) => f.dir === "send")
        .map((f) => object(f.data)["method"])
        .filter(Boolean)
        .slice(0, 3),
    ).toEqual(["initialize", "session/load", "session/set_config_option"]);
    expect(
      object(
        object(h.frames.find((f) => f.dir === "send" && method(f, "initialize"))?.data)["params"],
      )["clientCapabilities"],
    ).toMatchObject({ _meta: { subagents: {}, parameterizedModelPicker: true } });
  } finally {
    await h.session.close("idle");
  }
});
it("rejects active and queued input when its owned process lifetime ends", async () => {
  const h = await setup();
  const active = h.session.send(input("hold"), "queue").catch((error: unknown) => error);
  await h.wait((f) => method(f, "cursor/create_plan"));
  const queued = h.session.send(input("next"), "queue").catch((error: unknown) => error);
  h.controller.abort();
  const [a, b, exit] = await Promise.all([active, queued, h.exited]);
  expect(a).toBeInstanceOf(Error);
  expect(b).toBeInstanceOf(Error);
  expect(exit.deliberate).toBe(true);
  await h.session.close("shutdown");
});
it("reports unexpected process death and rejects future sends", async () => {
  const h = await setup(genericQuirks);
  try {
    await expect(h.session.send(input("die"), "queue")).rejects.toThrow();
    const exit = await h.exited;
    expect(exit.deliberate).toBe(false);
    await expect(h.session.send(input("next"), "queue")).rejects.toThrow("closed");
  } finally {
    await h.session.close("shutdown");
  }
});
it("limits a targeted cascade to the selected subtree", async () => {
  const h = await setup();
  try {
    await h.session.send(input("tree"), "queue");
    await h.session.interrupt({ agent: nativeAgentKey("session-test", "branch"), cascade: true });
    expect(
      h.frames
        .filter((f) => f.dir === "send" && method(f, "session/cancel"))
        .map((f) => object(object(f.data)["params"])["sessionId"]),
    ).toEqual(["branch", "leaf"]);
  } finally {
    await h.session.close("user");
  }
});
it("does not mislabel a crash as deliberate when cleanup immediately follows request failure", async () => {
  const h = await setup();
  await expect(h.session.send(input("die"), "queue")).rejects.toThrow();
  await h.session.close("shutdown");
  expect((await h.exited).deliberate).toBe(false);
});

it("rejects extra Antigravity question IDs before any answer is transmitted", async () => {
  const h = await setup(antigravityQuirks);
  try {
    const active = h.session.send(input("permission"), "queue");
    await h.wait((f) => method(f, "session/request_permission"));
    await expect(
      h.session.resolve(interactionKey(100), {
        kind: "question",
        answers: { extra: ["UNAPPROVED"], interaction_choice: ["a"] },
      }),
    ).rejects.toThrow("question");
    await h.session.resolve(interactionKey(100), {
      kind: "question",
      answers: { interaction_choice: ["a"] },
    });
    await active;
    expect(object((await h.wait((f) => method(f, "test/answer"))).data)["params"]).toEqual({
      outcome: { outcome: "selected", optionId: "a" },
    });
  } finally {
    await h.session.close("user");
  }
});
it("uses repaired native parentage for cascade cancellation", async () => {
  const h = await setup();
  try {
    await h.session.send(input("repair"), "queue");
    await h.session.interrupt({ agent: nativeAgentKey("session-test", "branch"), cascade: true });
    expect(
      h.frames
        .filter((f) => f.dir === "send" && method(f, "session/cancel"))
        .map((f) => object(object(f.data)["params"])["sessionId"]),
    ).toEqual(["branch", "leaf"]);
  } finally {
    await h.session.close("user");
  }
});
it("rejects unknown prompt completion and queued input instead of sending a second prompt", async () => {
  const h = await setup();
  try {
    const first = h.session.send(input("unknown"), "queue");
    const next = h.session.send(input("next"), "queue");
    await expect(first).rejects.toThrow("completion");
    await expect(next).rejects.toThrow();
    expect(h.frames.filter((f) => f.dir === "send" && method(f, "session/prompt"))).toHaveLength(1);
  } finally {
    await h.session.close("shutdown");
  }
});
it("rejects active work and stops the process when stdout ends while it is alive", async () => {
  const h = await setup();
  try {
    await expect(h.session.send(input("eof"), "queue")).rejects.toThrow();
    expect((await h.exited).deliberate).toBe(false);
  } finally {
    await h.session.close("shutdown");
  }
});
it("rejects ACP v2 before creating a native session", async () => {
  const frames: Frame[] = [];
  let child: ReturnType<typeof spawnSupervised> | undefined;
  await expect(
    openAcpSession(
      {
        threadId: ThreadId.parse("v2"),
        cwd: process.cwd(),
        signal: new AbortController().signal,
        onFrame: (frame) => frames.push(frame),
        onExit() {},
      },
      cursorQuirks,
      { command: process.execPath, args: [fake, "--protocol-v2"] },
      {
        now: () => 0,
        spawn(options) {
          child = spawnSupervised(options);
          return child;
        },
      },
    ),
  ).rejects.toThrow();
  expect(
    frames.some(
      (f) => f.dir === "recv" && object(object(f.data)["result"])["protocolVersion"] === 2,
    ),
  ).toBe(true);
  if (!child) throw new Error("Synthetic ACP server did not start");
  expect(await child.exited).toMatchObject({ reason: "stopped" });
  expect(frames.some((f) => method(f, "session/new"))).toBe(false);
});

it("rejects queued input at cancellation grace when a child never confirms termination", async () => {
  let clock = 1000;
  let scheduled: { delay: number; run(): void } | undefined;
  const h = await setup(cursorQuirks, false, {
    spawn: spawnSupervised,
    now: () => clock,
    schedule(delay, run) {
      scheduled = { delay, run };
      return () => {
        scheduled = undefined;
      };
    },
  });
  try {
    const active = h.session.send(input("grace"), "queue");
    await h.wait((f) => method(f, "session/update"));
    const queued = h.session.send(input("next"), "queue").catch((error: unknown) => error);
    await h.session.interrupt({ cascade: true });
    await active;
    expect(scheduled?.delay).toBe(12000);
    clock += 12000;
    scheduled?.run();
    expect(await queued).toBeInstanceOf(Error);
    expect((await h.exited).deliberate).toBe(false);
    expect(h.frames.filter((f) => f.dir === "send" && method(f, "session/prompt"))).toHaveLength(1);
  } finally {
    await h.session.close("shutdown");
  }
});

it("holds queued input for child traffic that precedes native registration", async () => {
  const h = await setup();
  try {
    await h.session.send(input("late"), "queue");
    const next = h.session.send(input("next"), "queue").catch((error: unknown) => error);
    expect(h.frames.filter((f) => f.dir === "send" && method(f, "session/prompt"))).toHaveLength(1);
    await h.session.interrupt({
      agent: nativeAgentKey("session-test", "native-late"),
      cascade: false,
    });
    expect(await next).toBeUndefined();
  } finally {
    await h.session.close("user");
  }
});

it("binds the root before queued input when session creation and root traffic share a read", async () => {
  const frames: Frame[] = [];
  const session = await openAcpSession(
    {
      threadId: ThreadId.parse("batched-new"),
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onFrame: (frame) => frames.push(frame),
      onExit() {},
    },
    cursorQuirks,
    { command: process.execPath, args: [fake, "--new-replay"] },
  );
  try {
    await session.send(input("next"), "queue");
    expect(frames.filter((f) => f.dir === "send" && method(f, "session/prompt"))).toHaveLength(1);
  } finally {
    await session.close("shutdown");
  }
});
