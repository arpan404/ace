import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SettingsService } from "@ace/settings";
import type { SpadeServiceState } from "../spade/rules.ts";
import type { SpadeServiceControl } from "../spade/service-control.ts";
import { parseArgs } from "./args.ts";
import { spadeCommand } from "./spade.ts";

/** A service manager that only records what it was asked to do. */
function serviceManager() {
  let state: SpadeServiceState = "absent";
  const asked: string[] = [];
  const control: SpadeServiceControl = {
    state: async () => state,
    installBinary: async () => void asked.push("installBinary"),
    register: async () => {
      asked.push("register");
      state = "running";
    },
    remove: async () => {
      asked.push("remove");
      state = "absent";
    },
  };
  return { control, asked, state: () => state };
}
async function saved(home: string): Promise<unknown> {
  const settings = new SettingsService({ dataDir: home });
  try {
    return (await settings.get("spade.enabled")).value;
  } finally {
    await settings.close();
  }
}

test("with no daemon running, ace spade on|off registers or removes Spade's service and saves the setting", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-spade-cli-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const printed: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((text: unknown, done?: unknown) => {
    printed.push(String(text));
    if (typeof done === "function") done();
    return true;
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const manager = serviceManager();

  await spadeCommand(parseArgs(["spade", "on"]), home, manager.control);
  expect(manager.asked).toEqual(["installBinary", "register"]);
  expect(await saved(home)).toBe(true);
  expect(printed.at(-1)).toContain("once the ace daemon runs");

  // Already running: on again leaves the service alone.
  await spadeCommand(parseArgs(["spade", "on"]), home, manager.control);
  expect(manager.asked).toEqual(["installBinary", "register"]);

  await spadeCommand(parseArgs(["spade", "off"]), home, manager.control);
  expect(manager.state()).toBe("absent");
  expect(await saved(home)).toBe(false);
});

test("ace spade refuses anything but on or off", async () => {
  await expect(
    spadeCommand(parseArgs(["spade", "maybe"]), "/nowhere", serviceManager().control),
  ).rejects.toThrow("ace spade on|off");
});
