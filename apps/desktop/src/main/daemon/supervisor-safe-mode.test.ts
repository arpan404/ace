import { describe, expect, it } from "vitest";
import { safeModeMessage, safeModeRestartMessage } from "./exit-policy.ts";
import { DaemonSupervisor } from "./supervisor.ts";
import { machine } from "./supervisor-test-support.ts";

describe("a daemon that keeps stopping as it starts", () => {
  it("is started in safe mode after two fast failures, and the person is told", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports, { stableMs: 60_000 });
    await supervisor.start();
    m.children.at(-1)?.die(1);
    expect(supervisor.current().message).not.toBe(safeModeRestartMessage);
    await m.advance(10_000);
    expect(m.children.at(-1)?.launch).toEqual({ safeMode: false });

    m.children.at(-1)?.die(1);
    expect(supervisor.current()).toMatchObject({
      state: "restarting",
      message: safeModeRestartMessage,
    });
    await m.advance(10_000);
    expect(m.children.at(-1)?.launch).toEqual({ safeMode: true });

    m.state.answering = true;
    await m.advance(300);
    expect(supervisor.current()).toMatchObject({ state: "running", message: safeModeMessage });
  });

  it("starts normally again once a safe run has stayed up, and after a repair", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports, { stableMs: 1_000 });
    await supervisor.start();
    for (let crash = 0; crash < 2; crash++) {
      m.children.at(-1)?.die(1);
      await m.advance(10_000);
    }
    m.state.answering = true;
    await m.advance(5_000);
    expect(m.children.at(-1)?.launch).toEqual({ safeMode: true });

    // It ran stably: the next crash is a first failure again.
    m.children.at(-1)?.die(1);
    await m.advance(10_000);
    expect(m.children.at(-1)?.launch).toEqual({ safeMode: false });

    m.children.at(-1)?.die(1);
    await m.advance(10_000);
    expect(m.children.at(-1)?.launch).toEqual({ safeMode: true });
    await supervisor.restart();
    expect(m.children.at(-1)?.launch).toEqual({ safeMode: false });
  });
});
