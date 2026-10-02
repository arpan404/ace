import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import type { Frame, ProviderSession } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { openAcpSession } from "./index.ts";
import { createAcpAdapter } from "./index.ts";
import { cursorQuirks } from "./quirks/cursor.ts";
import { antigravityQuirks } from "./quirks/antigravity.ts";
import { genericQuirks } from "./quirks/generic.ts";
import { interactionKey } from "./interactions.ts";
import { nativeAgentKey } from "./keys.ts";
import { object } from "./data.ts";
const fake = fileURLToPath(new URL("./testing/acp-server.ts", import.meta.url));
async function setup(quirks = cursorQuirks, resume = false) {
  const frames: Frame[] = [];
  const watchers = new Set<() => void>();
  const controller = new AbortController();
  const threadId = ThreadId.parse("session-test");
  const { promise: exited, resolve: exitResolve } = Promise.withResolvers<{
    deliberate: boolean;
  }>();
  const ctx = {
    threadId,
    cwd: process.cwd(),
    model: "test-model",
    signal: controller.signal,
    ...(resume ? { resume: { nativeSessionId: "native-root" } } : {}),
    onFrame(frame: Frame) {
      frames.push(frame);
      for (const watcher of watchers) watcher();
    },
    onExit: exitResolve,
  };
  const session: ProviderSession =
    quirks === genericQuirks
      ? await createAcpAdapter(quirks, { command: process.execPath, args: [fake] }).openSession(ctx)
      : await openAcpSession(ctx, quirks, { command: process.execPath, args: [fake] });
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
  return { session, frames, controller, exited, wait };
}
const input = (text: string) => [{ type: "text" as const, text }];
const method = (f: Frame, name: string) => object(f.data)["method"] === name;
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
        .slice(0, 4),
    ).toEqual(["initialize", "initialized", "session/load", "session/set_config_option"]);
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
