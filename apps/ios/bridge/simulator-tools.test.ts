import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { readSimulatorTools, simulatorToolRows } from "./simulator-tools.ts";

/* Settings › Simulators' tools on the phone, read from the machine over the real SDK. */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(daemon: FakeDaemon): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-simulator-tools-test"),
    expectedHostId: HostId.parse("mac"),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  client = owner;
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  return owner;
}
const machine = () => new FakeDaemon({ clock: Date.now, hostId: "mac", token: "ios-test-token" });
const signal = () => new AbortController().signal;

test("the simulator tools read as the web's rows, in its order, without Git", async () => {
  const tools = await readSimulatorTools(await connect(machine()), signal());
  expect(tools.problem).toBeNull();
  expect(tools.rows.map((row) => [row.name, row.status, row.detail])).toEqual([
    ["iOS Simulator", "Ready", "26.0"],
    ["Simulator streaming", "Ready", "0.1.49-beta.139.1"],
    [
      "Android emulators",
      "Not installed",
      "Install Android Studio, then set ANDROID_HOME to its SDK directory.",
    ],
  ]);
  expect(tools.rows[2]?.installer).toMatchObject({ label: "Install Android Studio" });
  expect(tools.rows.map((row) => row.download)).toEqual([null, null, null]);
});

test("missing simulator streaming offers ace's own download; a missing Xcode offers none", () => {
  const rows = simulatorToolRows([
    { id: "git", available: false, detail: "", hint: "Install Git." },
    { id: "serve-sim", available: false, detail: "", hint: "Download device tools." },
    { id: "xcode", available: false, detail: "", hint: "Install Xcode." },
  ]);
  expect(rows.map((row) => [row.id, row.download?.label ?? null])).toEqual([
    ["xcode", null],
    ["serve-sim", "Download"],
  ]);
  expect(rows[1]?.download).toEqual({
    label: "Download",
    working: "Downloading…",
    failed: "Couldn't download the simulator tools",
  });
});

test("a machine that can't check its tools says so, with no rows to trust", async () => {
  const daemon = machine();
  const owner = await connect(daemon);
  daemon.failRequests("diagnostics.request");
  expect(await readSimulatorTools(owner, signal())).toEqual({
    type: "simulators.tools",
    rows: [],
    problem: "Couldn't check the tools.",
    checkAgain: "Check again",
  });
});
