import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { DevicePlatform, startCapture, type DeviceRuntime } from "./index.ts";
import { fakeServeSim } from "./testing/fake-serve-sim.ts";

const udid = "11111111-1111-4111-8111-111111111111";
const runtime: DeviceRuntime = {
  now: () => 1000,
  id: () => "native",
  spawn: spawnRawSupervised,
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
/** devicectl's displays for an unfolded iPhone Duo: the inner screen (display 3) is lit. */
const duo = {
  result: {
    displays: [
      { displayId: 1, nativeSize: [1398, 2034], primary: true, active: false },
      { displayId: 3, nativeSize: [2007, 2853], primary: false, active: true },
    ],
  },
};

/**
 * A capture of a fake serve-sim (a 1206 x 2622 screen) with a fake screen helper whose
 * `--sim-touch` mode is ready (it records each step it is given) or can't reach the service.
 */
async function capture(options: { touch: "ready" | "unavailable"; displays?: unknown }) {
  const home = await mkdtemp(join(tmpdir(), "sim-digitizer-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sim = await fakeServeSim(home, "0.1.49-beta.139.1", udid);
  const steps = join(home, "steps");
  const helper = join(home, "ace-screen-helper");
  await writeFile(
    helper,
    `#!${process.execPath}
if (!process.argv.includes("--sim-touch")) process.exit(2);
if (${JSON.stringify(options.touch)} === "unavailable") { console.log('{"unavailable":"no digitizer"}'); process.exit(3); }
console.log('{"ready":true}');
process.stdin.on("data", (chunk) => require("node:fs").appendFileSync(${JSON.stringify(steps)}, chunk));
process.stdin.on("end", () => process.exit(0));
`,
  );
  await chmod(helper, 0o700);
  const platform = new DevicePlatform({
    platform: "darwin",
    home,
    env: { PATH: home },
    frameEncoder: helper,
    async probe(_command, args) {
      const stdout =
        args[0] === "-p"
          ? "/Applications/Xcode.app/Contents/Developer"
          : args[0] === "devicectl"
            ? JSON.stringify(options.displays ?? { result: { displays: [] } })
            : JSON.stringify({
                devices: { iOS: [{ udid, name: "iPhone", state: "Booted", isAvailable: true }] },
              });
      return { stdout, stderr: "", code: 0 };
    },
  });
  onTestFinished(() => platform.close());
  const live = await startCapture({
    device: { id: `ios:${udid}`, name: "iPhone", platform: "ios", state: "booted" },
    streamId: "native",
    fps: 30,
    platform,
    runtime,
    env: { PATH: home },
    publish: () => {},
    failure: () => {},
  });
  onTestFinished(() => live.stop());
  const input = live.input;
  if (!input) throw new Error("Missing native input");
  const recorded = async () =>
    (await readFile(steps, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  return { sim, input, recorded };
}

it("a tap on a Simulator goes through Xcode's own input service, not serve-sim's", async () => {
  const { sim, input, recorded } = await capture({ touch: "ready" });
  await input({ kind: "tap", x: 603, y: 1311 }, () => {});
  await expect.poll(recorded).toEqual([
    { phase: "down", x: 0.5, y: 0.5, edge: 0, target: 0 },
    { phase: "up", x: 0.5, y: 0.5, edge: 0, target: 0 },
  ]);
  const touches = sim.hid.filter((entry) => Array.isArray(entry) && [3, 5].includes(entry[0]));
  expect(touches).toEqual([]);
});

it("a swipe from the bottom edge stays an edge gesture until the finger lifts", async () => {
  const { input, recorded } = await capture({ touch: "ready" });
  await input({ kind: "swipe", x: 603, y: 2621, toX: 603, toY: 1311, durationMs: 32 }, () => {});
  await expect.poll(async () => (await recorded()).at(-1)).toMatchObject({ phase: "up" });
  const steps = await recorded();
  expect(steps.length).toBeGreaterThan(2);
  expect(steps.every((step) => (step as { edge: number }).edge === 3)).toBe(true);
});

it("when Xcode's input service can't be reached, taps go to serve-sim", async () => {
  const { sim, input, recorded } = await capture({ touch: "unavailable" });
  await input({ kind: "tap", x: 603, y: 1311 }, () => {});
  await expect
    .poll(() => sim.hid.filter((entry) => Array.isArray(entry) && entry[0] === 3))
    .toEqual([
      [3, { type: "begin", x: 0.5, y: 0.5 }],
      [3, { type: "end", x: 0.5, y: 0.5 }],
    ]);
  expect(await recorded()).toEqual([]);
});

it("an iPhone Duo streams its lit inner screen, and touches reach that screen", async () => {
  const { sim, input, recorded } = await capture({ touch: "ready", displays: duo });
  // serve-sim is asked for the lit screen's size, and the device isn't turned.
  await expect.poll(() => sim.hid).toContainEqual([13, { width: 2007, height: 2853 }]);
  expect(sim.rotations()).toBe(0);
  await input({ kind: "tap", x: 1003.5, y: 1426.5 }, () => {});
  await expect.poll(recorded).toEqual([
    { phase: "down", x: 0.5, y: 0.5, edge: 0, target: 3 },
    { phase: "up", x: 0.5, y: 0.5, edge: 0, target: 3 },
  ]);
});
