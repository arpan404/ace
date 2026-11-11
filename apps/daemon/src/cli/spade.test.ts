import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
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
  const printed = quietStdout(onTestFinished);
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

/** Stdout swallowed for the test, its text kept. */
function quietStdout(onTestFinished: (run: () => void) => void): string[] {
  const printed: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((text: unknown, done?: unknown) => {
    printed.push(String(text));
    if (typeof done === "function") done();
    return true;
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  return printed;
}
/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  server.close();
  await once(server, "close");
  return address.port;
}

test("a daemon-endpoint left by a daemon that is gone still lets ace spade act without it", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-spade-cli-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  quietStdout(onTestFinished);
  await writeFile(join(home, "daemon-endpoint"), `http://127.0.0.1:${await closedPort()}`);
  await writeFile(join(home, "daemon-token"), "t".repeat(64));
  const manager = serviceManager();
  await spadeCommand(parseArgs(["spade", "on"]), home, manager.control);
  expect(manager.asked).toEqual(["installBinary", "register"]);
  expect(await saved(home)).toBe(true);
});

test("a daemon that runs but doesn't answer is never worked around: ace spade fails and changes nothing", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-spade-cli-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  quietStdout(onTestFinished);
  // A daemon still starting: it takes connections and answers none of them.
  const held: Socket[] = [];
  const starting = createServer((socket) => held.push(socket));
  starting.listen(0, "127.0.0.1");
  await once(starting, "listening");
  onTestFinished(() => {
    for (const socket of held) socket.destroy();
    starting.close();
  });
  const address = starting.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await writeFile(join(home, "daemon-endpoint"), `http://127.0.0.1:${address.port}`);
  await writeFile(join(home, "daemon-token"), "t".repeat(64));
  const manager = serviceManager();

  await expect(
    spadeCommand(parseArgs(["spade", "on", "--timeout", "1s"]), home, manager.control),
  ).rejects.toThrow("running but didn't answer");
  expect(manager.asked).toEqual([]);
  expect(await saved(home)).not.toBe(true);
});

test("ace spade refuses anything but on or off", async () => {
  await expect(
    spadeCommand(parseArgs(["spade", "maybe"]), "/nowhere", serviceManager().control),
  ).rejects.toThrow("ace spade on|off");
});
