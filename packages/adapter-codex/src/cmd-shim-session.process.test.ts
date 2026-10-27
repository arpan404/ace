import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import type { Frame } from "@ace/engine-api";
import { sessionHarness } from "./session.test-helper.ts";
import { obj, str } from "./native.ts";
import { spawnSupervised } from "@ace/provider-kit/process";
import { aliveNow, withoutJob } from "@ace/provider-kit/testing/cmd-shim";

/*
 * Codex installed the way npm installs it on Windows: a `.cmd` shim that cmd.exe runs. The
 * session helper launches its fake through such a shim on Windows, so every case here goes
 * through PATHEXT lookup, the cmd.exe wrapper, the `%*` reparse and the Windows tree stop.
 */
const windowsHost = process.platform === "win32";
const received = (method: string) => (frame: Frame) =>
  frame.dir === "recv" && obj(frame.data)["method"] === method;
const sent = (method: string) => (frame: Frame) =>
  frame.dir === "send" && obj(frame.data)["method"] === method;
const proof = (id: string) => (frame: Frame) =>
  received("item/completed")(frame) && obj(obj(obj(frame.data)["params"])["item"])["id"] === id;
const proofText = (frame: Frame) => str(obj(obj(obj(frame.data)["params"])["item"])["text"]);
const text = (value: string) => [{ type: "text" as const, text: value }];
const exitNote = (frames: Frame[]) =>
  frames.map((f) => obj(f.data)).find((d) => d["event"] === "codex-session-exit");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const realTimers = {
  schedule(callback: () => void, delay: number) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

test.runIf(windowsHost)(
  "a .cmd-installed Codex starts app-server, resumes its native thread and streams a turn",
  async () => {
    const h = await sessionHarness(true);
    try {
      expect(h.session.nativeSessionId).toBe("native");
      expect(h.frames.some(sent("thread/resume"))).toBe(true);
      await h.session.send(text("running"), "queue");
      await h.wait(received("turn/started"));
      expect(h.replay.state.status.state).toBe("working");
      await h.session.send(text("followup"), "queue");
      expect(proofText(await h.wait(proof("queue-proof")))).toBe("queued: followup");
      await h.session.send(text("correction"), "steer");
      expect(proofText(await h.wait(proof("proof")))).toBe("steered: correction");
    } finally {
      await h.dispose();
    }
  },
);

test.runIf(windowsHost)(
  "a command approval answered on Windows reaches Codex with the exact offered decision",
  async () => {
    const h = await sessionHarness();
    try {
      await h.session.send(text("approval"), "queue");
      await h.wait(received("item/commandExecution/requestApproval"));
      await h.session.resolve(h.requestKey(100), {
        kind: "approval",
        optionId: "acceptWithExecpolicyAmendment",
      });
      expect(JSON.parse(proofText(await h.wait(proof("response-proof"))))).toEqual({
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } },
      });
    } finally {
      await h.dispose();
    }
  },
);

test.runIf(windowsHost)(
  "model and effort chosen on Windows reach the native session settings",
  async () => {
    const h = await sessionHarness();
    try {
      if (!h.session.configure) throw new Error("No live native configuration");
      const nativeId = h.session.nativeSessionId;
      await h.session.configure({
        provider: "codex",
        model: "selected-model",
        options: { effort: "high", serviceTier: "priority" },
      });
      expect(JSON.parse(proofText(await h.wait(proof("configuration-proof"))))).toEqual({
        model: "selected-model",
        effort: "high",
        serviceTier: "priority",
      });
      expect(h.session.nativeSessionId).toBe(nativeId);
    } finally {
      await h.dispose();
    }
  },
);

test.runIf(windowsHost)(
  "interrupting a turn on Windows sends turn/interrupt and leaves app-server running",
  async () => {
    const h = await sessionHarness();
    try {
      await h.session.send(text("tree"), "queue");
      await h.wait(received("item/started"));
      await h.session.interrupt({ cascade: false });
      await h.wait(received("turn/completed"));
      expect(h.frames.some(sent("turn/interrupt"))).toBe(true);
      expect(h.exits).toEqual([]);
      // Children and background terminals are untouched, so the thread is not done.
      expect(h.replay.state.status.state).not.toBe("done");
      // The same app-server takes the next input as a new turn.
      const barrier = h.frames.at(-1)?.seq ?? 0;
      await h.session.send(text("next"), "steer");
      await h.wait((f) => f.seq > barrier && received("turn/started")(f));
      expect(
        h.frames
          .filter((f) => f.seq > barrier && sent("turn/start")(f))
          .map((f) => obj(obj(f.data)["params"])["input"]),
      ).toContainEqual([{ type: "text", text: "next", text_elements: [] }]);
      expect(h.exits).toEqual([]);
    } finally {
      await h.dispose();
    }
  },
);

test.runIf(windowsHost)(
  "closing a Windows Codex ends app-server through its input closing, not a forced kill",
  async () => {
    // A grace far longer than the test proves the forced tree stop never ran.
    const h = await sessionHarness(
      false,
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ...realTimers,
        stopGraceMs: 600_000,
      },
    );
    try {
      await h.session.send(text("running"), "queue");
      await h.wait(received("turn/started"));
      await h.session.close("shutdown");
      expect((await h.exited).deliberate).toBe(true);
      expect(exitNote(h.frames)).toMatchObject({ deliberate: true, code: 0 });
      expect(h.exits).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  },
);

test.runIf(windowsHost)(
  "a Windows Codex that outlives its input closing is forced down by the tree stop",
  async () => {
    const h = await sessionHarness(
      false,
      "ignore-term",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ...realTimers,
        stopGraceMs: 500,
      },
    );
    try {
      await h.session.close("shutdown");
      expect((await h.exited).deliberate).toBe(true);
      // The fake ignores stdin closing, so only the tree stop can end it.
      const pid = Number(await readFile(join(h.cwd, "fake-codex.pid"), "utf8"));
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
      expect(h.exits).toHaveLength(1);
      await expect(h.session.send(text("after"), "steer")).rejects.toThrow("closed");
    } finally {
      await h.dispose();
    }
  },
);

test.runIf(windowsHost)("aborting a Windows Codex session closes it once", async () => {
  const h = await sessionHarness();
  try {
    h.controller.abort();
    expect((await h.exited).deliberate).toBe(true);
    await expect(h.session.send(text("after"), "queue")).rejects.toThrow("closed");
    await h.session.close("user");
    expect(h.exits).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});

test.runIf(windowsHost)(
  "an unexpected Codex exit through the .cmd shim keeps its exit code and fails the thread",
  async () => {
    const h = await sessionHarness();
    try {
      await h.session.send(text("exit"), "queue");
      expect((await h.exited).deliberate).toBe(false);
      expect(exitNote(h.frames)).toMatchObject({ deliberate: false, code: 7 });
      expect(h.replay.state.status.state).toBe("failed");
    } finally {
      await h.dispose();
    }
  },
);

test.runIf(windowsHost)(
  "a helper holding a Windows Codex's pipes ends with it instead of hanging shutdown",
  async () => {
    const h = await sessionHarness(
      false,
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      realTimers,
    );
    let helper: number | undefined;
    try {
      await h.session.send(text("group-pipes"), "steer");
      const frame = await h.wait(received("test/helper"));
      helper = z
        .number()
        .int()
        .positive()
        .parse(obj(obj(frame.data)["params"])["pid"]);
      // The helper sleeps for 10 s. Its pipes close well before that only if the Job Object
      // holding the provider's tree ended it when the provider exited.
      const exit = await Promise.race([
        h.exited,
        new Promise<undefined>((resolve) => setTimeout(resolve, 5_000, undefined)),
      ]);
      expect(exit?.deliberate).toBe(false);
      expect(alive(helper)).toBe(false);
      expect(h.replay.state.items["final-output"]).toMatchObject({
        type: "message",
        parts: [{ type: "text", text: "accepted final output" }],
      });
      await h.session.close("shutdown");
      expect(h.exits).toHaveLength(1);
    } finally {
      if (helper !== undefined && alive(helper)) process.kill(helper);
      await h.dispose();
    }
  },
);

test.runIf(windowsHost)(
  "closing a Windows Codex that ends on EOF leaves none of its tree alive, even with no job",
  async () => {
    const h = await sessionHarness(
      false,
      "orphan-child",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ...realTimers,
        stopGraceMs: 30_000,
        spawn: (options) => spawnSupervised(withoutJob(options)),
      },
    );
    try {
      const child = z
        .number()
        .int()
        .positive()
        .parse(Number(await readFile(join(h.cwd, "fake-codex-child.pid"), "utf8")));
      expect(aliveNow(child)).toBe(true);
      await h.session.close("shutdown");
      // Checked the moment close returns, not polled afterwards.
      expect(aliveNow(child)).toBe(false);
      expect((await h.exited).deliberate).toBe(true);
    } finally {
      await h.dispose();
    }
  },
);
