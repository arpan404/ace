import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { ScreenManager } from "@ace/screen";
import { DeviceOperation } from "@ace/protocol/devices";
import {
  spawnSupervised,
  spawnRawSupervised,
  type SupervisedProcess,
} from "@ace/provider-kit/process";
import { DevicesService, DevicePlatform, type Actor } from "./index.ts";
const deviceId = "ios:11111111-1111-4111-8111-111111111111";
const human: Actor = { kind: "human", owner: "reader" };
function noop() {}
it("a terminated Simulator whose stop reported an error can be disabled, reapproved and captured again", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-simulator-recovery-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const tool of ["xcode-select", "xcrun", "open"]) {
    const path = join(root, tool);
    await writeFile(path, `#!${process.execPath}\n`);
    await chmod(path, 0o700);
  }
  let id = 0;
  const processes: SupervisedProcess[] = [];
  const screen = new ScreenManager({
    command: process.execPath,
    args: [new URL("./testing/stop-error-helper.ts", import.meta.url).pathname],
    env: { STOP_ERROR_MARKER: join(root, "rejected") },
    platform: "darwin",
    protocolVersion: 2,
    nextId: () => `screen-${++id}`,
    recordingDirectory: root,
    publishArtifact: async () => {},
    spawn(options) {
      const proc = spawnSupervised(options);
      processes.push(proc);
      return proc;
    },
  });
  onTestFinished(() => screen.close());
  const platform = new DevicePlatform({
    platform: "darwin",
    home: root,
    env: { PATH: root },
    screen,
    async probe(_command, args) {
      return {
        code: 0,
        stderr: "",
        stdout:
          args[0] === "-p"
            ? "/Applications/Xcode.app/Contents/Developer"
            : JSON.stringify({
                devices: {
                  iOS: [
                    { udid: deviceId.slice(4), name: "iPhone", state: "Booted", isAvailable: true },
                  ],
                },
              }),
      };
    },
  });
  const service = new DevicesService({
    platform,
    screen,
    env: {},
    runtime: {
      now: () => 0,
      id: () => `device-${++id}`,
      spawn: spawnRawSupervised,
      after: () => noop,
    },
    recordingDirectory: root,
    publishArtifact: async () => {},
  });
  onTestFinished(() => service.close());
  const request = (operation: unknown) => service.request(DeviceOperation.parse(operation), human);
  const approve = async () => {
    await request({ op: "enable", enabled: true });
    await request({ op: "approve", deviceId, threadId: "thread-1", allowed: true });
  };
  await approve();
  await request({ op: "start", deviceId });
  expect((await service.screenshot(deviceId, human)).payload.toString()).toBe("simulator-frame");
  const native = processes[0];
  if (!native) throw new Error("No real helper process");
  await expect(request({ op: "stop", deviceId })).rejects.toThrow("Simulator native stop rejected");
  expect((await native.exited).reason).toBe("stopped");
  expect(service.states()[0]).toMatchObject({
    lifecycle: "failed",
    error: { message: expect.stringContaining("Simulator native stop rejected") },
  });
  // A replacement can start immediately after confirmed termination, without cleanup retry.
  await request({ op: "start", deviceId });
  expect(service.states()[0]?.lifecycle).toBe("live");
  expect((await service.screenshot(deviceId, human)).payload.toString()).toBe("simulator-frame");
  await request({ op: "stop", deviceId });
  await request({ op: "stop", deviceId });
  await request({ op: "enable", enabled: false });
  expect(service.states()).toEqual([]);
  await approve();
  await request({ op: "start", deviceId });
  expect(service.states()[0]?.lifecycle).toBe("live");
  expect((await service.screenshot(deviceId, human)).payload.toString()).toBe("simulator-frame");
  await request({ op: "stop", deviceId });
});
