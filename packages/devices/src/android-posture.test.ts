import { expect, it } from "vitest";
import { EmulatorPostures, type EmulatorConsole } from "./android-posture.ts";

const id = "android:Pixel_9_Pro_Fold";

/**
 * Stands in for an emulator's console as adb reaches it, answering the way the Android
 * emulator does: `emu posture 1|2|3` moves the hinge to 0°, 90° or 180°.
 */
function emulator(options: { hinge?: boolean; console?: boolean } = {}) {
  let angle = 180;
  const asked: string[] = [];
  const adb: EmulatorConsole = async (args) => {
    asked.push(args.join(" "));
    if (options.console === false) return { code: 1, stdout: "" };
    const command = args.slice(1).join(" ");
    if (command === "sensor status")
      return {
        code: 0,
        stdout: `acceleration: enabled.\nhinge-angle0: ${options.hinge === false ? "disabled" : "enabled"}.\nhinge-angle1: disabled.\nOK\n`,
      };
    if (command === "sensor get hinge-angle0")
      return { code: 0, stdout: `hinge-angle0 = ${angle}\nOK\n` };
    if (args[1] === "posture") {
      angle = { "1": 0, "2": 90, "3": 180 }[args[2] ?? ""] ?? angle;
      return { code: 0, stdout: "OK\n" };
    }
    return { code: 0, stdout: "KO: unknown command\n" };
  };
  return { adb, asked };
}

it("a Pixel Fold emulator reads open, folds shut, then half open", async () => {
  const { adb } = emulator();
  const postures = new EmulatorPostures();
  expect(await postures.read(id, adb)).toBe("open");
  expect(await postures.set(id, adb, "closed")).toBe("closed");
  expect(await postures.read(id, adb)).toBe("closed");
  await postures.set(id, adb, "partiallyOpen");
  expect(await postures.read(id, adb)).toBe("partiallyOpen");
});

it("an emulator without a hinge has no posture and refuses to fold", async () => {
  const { adb, asked } = emulator({ hinge: false });
  const postures = new EmulatorPostures();
  expect(await postures.read(id, adb)).toBeUndefined();
  await expect(postures.set(id, adb, "closed")).rejects.toMatchObject({ code: "not_supported" });
  expect(asked.some((command) => command.startsWith("emu posture"))).toBe(false);
});

it("a physical phone, which has no emulator console, has no posture and soon stops being asked", async () => {
  const { adb, asked } = emulator({ console: false });
  const postures = new EmulatorPostures();
  for (let read = 0; read < 10; read++) expect(await postures.read(id, adb)).toBeUndefined();
  expect(asked.length).toBeLessThan(10);
});
