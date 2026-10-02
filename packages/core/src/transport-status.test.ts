import { describe, expect, it } from "vitest";
import { deriveThreadStatus } from "./index.ts";
import { activeRoot, status } from "./status-test-helper.ts";
import { harness } from "./test-helper.ts";

const transport = { silenceMs: 100, liveness: "transport" } as const;

describe("transport liveness through facts", () => {
  it("healthy transport keeps a quiet retry alive and disables per-agent silence", () => {
    const h = activeRoot(transport);
    h.see("child", "root");
    h.start("child");
    h.end("child");
    h.send({ type: "retry", agent: "root", on: "upstream", attempt: 3, until: 600 }, 200);
    h.send({ type: "signal", agent: "child" }, 450);
    h.send({ type: "tick" }, 500);
    expect(status(h, 500)).toEqual({
      state: "blocked",
      on: "upstream",
      refs: [],
      attempt: 3,
      until: 600,
    });
    const quiet = activeRoot(transport);
    quiet.see("quiet-child", "root");
    quiet.start("quiet-child");
    quiet.see("noisy-sibling", "root");
    quiet.start("noisy-sibling");
    quiet.end("noisy-sibling");
    quiet.send({ type: "signal", agent: "noisy-sibling" }, 450);
    quiet.send({ type: "tick" }, 500);
    expect(status(quiet, 500, "quiet-child")).toEqual({
      state: "working",
      activity: "starting_turn",
    });
  });

  it.each(["retry", "tool", "starting"] as const)(
    "lost transport marks %s unresponsive",
    (work) => {
      const h = work === "starting" ? harness("codex", transport) : activeRoot(transport);
      if (work === "starting") h.see();
      if (work === "retry")
        h.send({ type: "retry", agent: "root", on: "upstream", attempt: 2, until: 900 });
      if (work === "tool") h.shell();
      h.send({ type: "signal", agent: "root" }, 200);
      h.send({ type: "tick" }, 300);
      expect(status(h, 300).state).not.toBe("unresponsive");
      h.send({ type: "tick" }, 301);
      expect(status(h, 301)).toEqual({ state: "unresponsive", lastSignalAt: 200 });
    },
  );

  it.each(["completed", "interrupted", "failed"] as const)(
    "settled %s runs survive transport loss",
    (outcome) => {
      const h = activeRoot(transport);
      h.end("root", outcome);
      h.send({ type: "tick" }, 1000);
      expect(status(h, 1000).state).toBe(outcome === "completed" ? "idle" : outcome);
    },
  );

  it("process exit preserves its failure reason after transport loss", () => {
    const h = activeRoot(transport);
    h.send({ type: "process.exited", deliberate: false });
    h.send({ type: "tick" }, 1000);
    expect(status(h, 1000)).toMatchObject({ state: "failed", error: { kind: "process_exit" } });
  });

  it("attention and background-task thread precedence survive transport loss", () => {
    const h = activeRoot(transport);
    h.question();
    h.send({ type: "tick" }, 1000);
    expect(status(h, 1000).state).toBe("unresponsive");
    expect(deriveThreadStatus(h.state)).toEqual({ state: "needs_you", interactions: 1 });
    h.send({ type: "interaction.closed", interaction: "question", state: "expired" });
    h.background();
    h.send({ type: "tick" }, 2000);
    expect(status(h, 2000).state).toBe("unresponsive");
    expect(deriveThreadStatus(h.state)).toEqual({ state: "waiting", on: "background_task" });
  });
});
