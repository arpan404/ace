import { exitCodes } from "@ace/service/exit-codes";
import { describe, expect, it } from "vitest";
import { DaemonSupervisor } from "./supervisor.ts";
import { machine, track } from "./supervisor-test-support.ts";

/** The distinct steps a start reported, in order, while it was not running. */
const stages = (seen: { state: string; stage?: string | undefined }[]) =>
  seen
    .map((status) => (status.state === "running" ? "running" : status.stage))
    .filter((stage, index, all) => stage !== undefined && stage !== all[index - 1]);

describe("daemon supervisor start stages", () => {
  it("names each step of a fresh start, and running clears it", async () => {
    const m = machine();
    // The endpoint file is watched: the daemon writing it is seen at once.
    const written = Promise.withResolvers<void>();
    m.ports.watchEndpoint = () => ({ changed: () => written.promise, close: () => {} });
    const supervisor = new DaemonSupervisor(m.ports);
    const seen = track(supervisor);
    await supervisor.start();
    expect(supervisor.current()).toMatchObject({ state: "starting", stage: "launching" });

    // The daemon listens and writes its endpoint, then needs a moment before it answers.
    written.resolve();
    await m.advance(0);
    expect(supervisor.current().stage).toBe("warming");
    m.state.answering = true;
    await m.advance(300);

    expect(supervisor.current().state).toBe("running");
    expect(supervisor.current().stage).toBeUndefined();
    expect(stages(seen)).toEqual(["looking", "launching", "warming", "admission", "running"]);
  });

  it("says it is starting the login service when one is installed", async () => {
    const m = machine();
    m.ports.service = {
      active: async () => false,
      start: async () => {},
    };
    const supervisor = new DaemonSupervisor(m.ports);
    const seen = track(supervisor);
    void supervisor.start();
    await m.advance(0);
    expect(stages(seen)).toContain("service");
  });

  it("stays on waiting for the previous daemon while its lock holds, through each retry", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports);
    void supervisor.start();
    await m.advance(0);
    const seen = track(supervisor);
    for (let i = 0; i < 3; i++) {
      m.children.at(-1)?.die(exitCodes["lock-held"]);
      await m.advance(6_000);
    }
    expect(supervisor.current()).toMatchObject({ state: "starting", stage: "lock-wait" });
    // Retrying our own start never flickers back to an earlier step while the lock holds.
    expect(stages(seen)).toEqual(["lock-wait"]);

    m.state.answering = true;
    await m.advance(1_000);
    expect(supervisor.current().state).toBe("running");
    expect(supervisor.current().stage).toBeUndefined();
  });
});
