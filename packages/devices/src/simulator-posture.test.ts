import { expect, it } from "vitest";
import { SimulatorPostures, type PostureCommand } from "./simulator-posture.ts";

const udid = "D8ABBF92-C22F-4435-8D35-473FC8E315F5";
const display = (primary: boolean, lit: boolean) => ({
  primary,
  active: !primary,
  backlightState: lit ? "activeOn" : "off",
});

/**
 * Stands in for the two processes ace can't run in a test: `xcrun devicectl` reports the screens
 * of a simulated iPhone Duo, and the screen helper moves its hinge. Folding past the halfway
 * angle lights the cover screen, as the simulator does.
 */
function simulatedDuo(options: { helper?: "works" | "unavailable"; screens?: number } = {}) {
  const hinge = { angle: 180, moves: [] as { from: number; to: number }[] };
  const run: PostureCommand = async (command, args) => {
    if (command === "xcrun") {
      const displays = [display(true, hinge.angle < 90), display(false, hinge.angle >= 90)];
      return {
        code: 0,
        stdout: JSON.stringify({ result: { displays: displays.slice(0, options.screens ?? 2) } }),
      };
    }
    if (options.helper === "unavailable")
      return { code: 3, stdout: '{"unavailable":"the simulator has no hinge service"}\n' };
    if (args.includes("--check")) return { code: 0, stdout: '{"available":true}\n' };
    const from = Number(args[args.indexOf("--from") + 1]);
    const to = Number(args[args.indexOf("--to") + 1]);
    hinge.moves.push({ from, to });
    hinge.angle = to;
    return { code: 0, stdout: '{"done":true}\n' };
  };
  const postures = new SimulatorPostures({ helper: "helper", xcrun: async () => "xcrun", run });
  return { postures, hinge };
}

it("an open iPhone Duo folds shut from flat and then reads as closed", async () => {
  const { postures, hinge } = simulatedDuo();
  expect(await postures.read(udid)).toBe("open");
  expect(await postures.set(udid, "closed")).toBe("closed");
  expect(hinge.moves).toEqual([{ from: 180, to: 0 }]);
  expect(await postures.read(udid)).toBe("closed");
});

it("half open sweeps from wherever the hinge is and is remembered on the inner screen", async () => {
  const { postures, hinge } = simulatedDuo();
  await postures.set(udid, "closed");
  await postures.set(udid, "partiallyOpen");
  expect(hinge.moves.at(-1)).toEqual({ from: 0, to: 120 });
  expect(await postures.read(udid)).toBe("partiallyOpen");
  await postures.set(udid, "open");
  expect(hinge.moves.at(-1)).toEqual({ from: 120, to: 180 });
  expect(await postures.read(udid)).toBe("open");
});

it("a phone with one screen has no posture and refuses to fold", async () => {
  const { postures, hinge } = simulatedDuo({ screens: 1 });
  expect(await postures.read(udid)).toBeUndefined();
  await expect(postures.set(udid, "closed")).rejects.toMatchObject({ code: "not_supported" });
  expect(hinge.moves).toEqual([]);
});

it("an Xcode without the hinge service offers no posture at all", async () => {
  const { postures } = simulatedDuo({ helper: "unavailable" });
  expect(await postures.read(udid)).toBeUndefined();
});
