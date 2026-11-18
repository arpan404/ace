import { describe, expect, it } from "vitest";
import { appSocketProven } from "@ace/service/app-key";
import { DaemonSupervisor } from "./supervisor.ts";
import { machine } from "./supervisor-test-support.ts";

/** Keys 1, 2, 3…: each spawn's own, so a test can tell them apart. */
function keys() {
  let next = 0;
  return () => new Uint8Array(32).fill(++next);
}

const proves = (key: Uint8Array | undefined, proof: string | undefined) =>
  key !== undefined && proof !== undefined && appSocketProven(key, 4242, proof);

describe("the page's proof that it is the desktop app's (ADR 0178 §12.8)", () => {
  it("is made for the daemon the app spawned, with the key that daemon was given", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor({ ...m.ports, appKey: keys() });
    await supervisor.start();
    m.state.answering = true;
    await m.advance(300);
    const daemon = await supervisor.ready();
    expect(proves(m.children[0]?.launch.appKey, daemon.appProof)).toBe(true);
  });

  it("is never made for a daemon the app adopted, which no key of the app's reached", async () => {
    const m = machine();
    m.state.answering = true;
    m.state.external = true;
    const supervisor = new DaemonSupervisor({ ...m.ports, appKey: keys() });
    await supervisor.start();
    expect(m.children).toHaveLength(0);
    expect((await supervisor.ready()).appProof).toBeUndefined();
  });

  it("follows a restart: the daemon started again gets a new key, and the old proof is gone", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor({ ...m.ports, appKey: keys() });
    await supervisor.start();
    m.state.answering = true;
    await m.advance(300);
    const first = (await supervisor.ready()).appProof;
    m.children[0]?.die(1);
    await m.advance(500);
    m.state.answering = true;
    await m.advance(300);
    const second = (await supervisor.ready()).appProof;
    expect(proves(m.children[1]?.launch.appKey, second)).toBe(true);
    expect(proves(m.children[1]?.launch.appKey, first)).toBe(false);
  });
});
