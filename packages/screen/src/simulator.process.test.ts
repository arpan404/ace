import { expect, it } from "vitest";
import { Simulators } from "./index.ts";
const udid = "b3d4c194-9f4c-40cc-bdfc-22918843be74";
it("simulator discovery omits unavailable devices and booting opens the selected simulator", async () => {
  const effects: string[][] = [];
  const simulator = new Simulators("darwin", async (command, args) => {
    if (args[1] === "list")
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          devices: {
            ios: [
              { udid, name: "iPhone", state: "Shutdown", isAvailable: true },
              {
                udid: "d9a61109-f84b-40c8-b084-e2de06490ad8",
                name: "unavailable",
                state: "Shutdown",
                isAvailable: false,
              },
            ],
          },
        }),
      };
    effects.push([command, ...args]);
    return { code: 0, stderr: "", stdout: "" };
  });
  expect(await simulator.list()).toEqual([
    { udid, name: "iPhone", state: "Shutdown", isAvailable: true, runtime: "ios" },
  ]);
  await simulator.boot(udid);
  expect(effects).toEqual([
    ["xcrun", "simctl", "boot", udid],
    ["open", "-a", "Simulator", "--args", "-CurrentDeviceUDID", udid],
  ]);
  await expect(simulator.boot("invalid")).rejects.toThrow();
});
it("unsupported hosts list no simulators and failed simctl commands surface errors", async () => {
  expect(
    await new Simulators("linux", async () => {
      throw new Error("Must not execute");
    }).list(),
  ).toEqual([]);
  await expect(
    new Simulators("darwin", async () => ({ code: 1, stderr: "no Xcode", stdout: "" })).list(),
  ).rejects.toThrow("discovery failed");
});
