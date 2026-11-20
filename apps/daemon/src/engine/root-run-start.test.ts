import { describe, expect, it } from "vitest";
import { rootRunStart } from "./root-run-start.ts";

const parcelNotice = { kind: "thread.send", trigger: "background_completion" as const };

describe("a root run's start", () => {
  it("takes ace's own notice it was started for, and carries the notice's trigger", () => {
    expect(rootRunStart("user", parcelNotice)).toEqual({
      trigger: "background_completion",
      takesInput: true,
    });
    expect(rootRunStart("unknown", { kind: "thread.send", trigger: "goal" })).toEqual({
      trigger: "goal",
      takesInput: true,
    });
  });

  it("takes a delegated child's first message and a parent's follow-up", () => {
    expect(rootRunStart("queue", { kind: "thread.create", trigger: "spawn" })).toEqual({
      trigger: "spawn",
      takesInput: true,
    });
    expect(rootRunStart("user", { kind: "thread.send", trigger: "parent_agent" })).toEqual({
      trigger: "parent_agent",
      takesInput: true,
    });
  });

  it("takes a person's message, which has no trigger of its own", () => {
    expect(rootRunStart("user", { kind: "thread.send" })).toEqual({
      trigger: "user",
      takesInput: true,
    });
  });

  it("leaves ace's waiting notice untaken when the provider woke for its own reasons", () => {
    expect(rootRunStart("background_completion", parcelNotice)).toEqual({
      trigger: "background_completion",
      takesInput: false,
    });
    expect(rootRunStart("goal", parcelNotice)).toEqual({ trigger: "goal", takesInput: false });
  });

  it("takes nothing when a provider's own child wakes the root with its result", () => {
    const message = { kind: "thread.send" };
    expect(rootRunStart("subagent_result", message)).toEqual({
      trigger: "subagent_result",
      takesInput: false,
    });
    expect(rootRunStart("subagent_result", undefined)).toEqual({
      trigger: "subagent_result",
      takesInput: false,
    });
  });

  it("takes ace's own child result, handed to the provider as given input", () => {
    expect(rootRunStart("user", { kind: "thread.send", trigger: "subagent_result" })).toEqual({
      trigger: "subagent_result",
      takesInput: true,
    });
  });

  it("a resumed run takes its input; a goal run with nothing waiting takes none", () => {
    expect(rootRunStart("restart", parcelNotice)).toEqual({
      trigger: "restart",
      takesInput: true,
    });
    expect(rootRunStart("goal", undefined)).toEqual({ trigger: "goal", takesInput: false });
  });

  it("keeps a switch's or merge's own trigger: only a message is relabelled", () => {
    expect(
      rootRunStart("user", { kind: "thread.switch", trigger: "background_completion" }),
    ).toEqual({ trigger: "user", takesInput: true });
  });
});
