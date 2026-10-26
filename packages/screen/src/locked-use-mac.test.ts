import type { LockedUseStatus } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { macLockedUseInstaller, type PrivilegedRunner } from "./locked-use-mac.ts";
import {
  emptyLayout,
  fakeMac,
  fakeTeam,
  fakeVersion,
  installedLayout,
  type FakeMacLayout,
} from "./locked-use-fake-mac.ts";

function setup(layout: FakeMacLayout, runner: Partial<PrivilegedRunner> = {}, intent = true) {
  const mac = fakeMac(layout);
  const ticks: (() => void)[] = [];
  const installer = macLockedUseInstaller({
    host: mac.host,
    expect: { bundleVersion: fakeVersion, team: fakeTeam },
    readIntent: () => Promise.resolve(intent),
    intervalMs: 1000,
    schedule: (_ms, tick) => {
      ticks.push(tick);
      return () => ticks.splice(ticks.indexOf(tick), 1);
    },
    runner: {
      install: runner.install ?? (() => Promise.resolve()),
      remove: runner.remove ?? (() => Promise.resolve()),
    },
  });
  const seen: LockedUseStatus[] = [];
  const stop = installer.subscribe((status) => seen.push(status));
  const tick = async () => {
    mac.clock.now += 1000;
    for (const run of ticks) run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { installer, seen, stop, tick, ticks };
}

describe("locked use installer on macOS", () => {
  it("shows installing, then the detected on once the runner installed everything", async () => {
    const layout = emptyLayout();
    const { installer, seen } = setup(layout, {
      install: () => {
        Object.assign(layout, installedLayout());
        return Promise.resolve();
      },
    });
    expect(await installer.install()).toEqual({ state: "on" });
    expect(seen).toEqual([{ state: "installing" }, { state: "on" }]);
  });

  it("fails the install when the runner succeeds but detection doesn't find it on", async () => {
    const layout = emptyLayout();
    const { installer, seen } = setup(layout, {
      install: () => {
        Object.assign(layout, { ...installedLayout(), guardian: false });
        return Promise.resolve();
      },
    });
    const status = await installer.install();
    expect(status).toEqual({ state: "installFailed", reason: "The relock guardian isn't loaded." });
    expect(seen.at(-1)).toEqual(status);
  });

  it("fails the install with the runner's reason when it throws, even if parts landed", async () => {
    const layout = emptyLayout();
    const { installer } = setup(layout, {
      install: () => {
        Object.assign(layout, installedLayout());
        return Promise.reject(new Error("privileged install pending owner review"));
      },
    });
    expect(await installer.install()).toEqual({
      state: "installFailed",
      reason: "privileged install pending owner review",
    });
  });

  it("removal verifies nothing of ace is left and reports off", async () => {
    const layout = installedLayout();
    const { installer, seen } = setup(layout, {
      remove: () => {
        Object.assign(layout, emptyLayout());
        return Promise.resolve();
      },
    });
    expect(await installer.remove()).toEqual({ state: "off" });
    expect(seen).toEqual([{ state: "installing" }, { state: "off" }]);
  });

  it("removal that leaves a daemon behind needs repair", async () => {
    const layout = installedLayout();
    const { installer } = setup(layout, {
      remove: () => {
        Object.assign(layout, { ...emptyLayout(), broker: true });
        return Promise.resolve();
      },
    });
    expect(await installer.remove()).toMatchObject({ state: "driftRepairNeeded" });
  });

  it("repair removes drifted parts, then installs and verifies", async () => {
    const layout = { ...installedLayout(), team: "ZZZZZ99999" };
    const calls: string[] = [];
    const { installer } = setup(layout, {
      remove: () => {
        calls.push("remove");
        Object.assign(layout, emptyLayout());
        return Promise.resolve();
      },
      install: () => {
        calls.push("install");
        Object.assign(layout, installedLayout());
        return Promise.resolve();
      },
    });
    expect(await installer.repair()).toEqual({ state: "on" });
    expect(calls).toEqual(["remove", "install"]);
  });

  it("repair stops at drift when removal leaves residue, without installing over it", async () => {
    const layout = { ...installedLayout(), version: "0" };
    const calls: string[] = [];
    const { installer } = setup(layout, {
      remove: () => {
        calls.push("remove");
        return Promise.resolve();
      },
      install: () => {
        calls.push("install");
        return Promise.resolve();
      },
    });
    expect(await installer.repair()).toMatchObject({ state: "driftRepairNeeded" });
    expect(calls).toEqual(["remove"]);
  });

  it("subscribers hear a change once and nothing while the Mac stays the same", async () => {
    const layout = installedLayout();
    const { seen, tick } = setup(layout);
    await tick();
    await tick();
    expect(seen).toEqual([{ state: "on" }]);
    layout.guardian = false;
    await tick();
    await tick();
    expect(seen).toEqual([
      { state: "on" },
      { state: "driftRepairNeeded", reason: "The relock guardian isn't loaded." },
    ]);
  });

  it("stops re-detecting once the last subscriber leaves", async () => {
    const { stop, ticks } = setup(emptyLayout());
    expect(ticks).toHaveLength(1);
    stop();
    expect(ticks).toHaveLength(0);
  });
});
