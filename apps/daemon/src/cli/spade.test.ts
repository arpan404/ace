import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { spadeInThisRelease } from "@ace/settings/beta";
import type { SpadeServiceState } from "../spade/rules.ts";
import type { SpadeServiceControl } from "../spade/service-control.ts";
import type { Args } from "./args.ts";
import { betaFeature, readFeatures, switchFeature } from "./features.ts";
import { CliFailure } from "./output.ts";
import { featureWords, spadeSwitchWords } from "./render/spade.ts";
import { switchSpade } from "./spade.ts";

const noFlags: Args = { words: [], flags: {} };

/** A fresh home; `shown` turns Spade on in Settings › Beta. */
async function home(onTestFinished: (run: () => Promise<void>) => void, shown = false) {
  const dir = await mkdtemp(join(tmpdir(), "ace-spade-cli-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  if (shown)
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ version: 2, settings: { "beta.spade": true } }),
    );
  return dir;
}

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

async function saved(dir: string, key: "spade.enabled" | "beta.spade"): Promise<unknown> {
  const settings = new SettingsService({ dataDir: dir });
  try {
    return (await settings.get(key)).value;
  } finally {
    await settings.close();
  }
}

const feature = async (
  dir: string,
  name: "spade" | "marketplace",
  on: boolean,
  control: SpadeServiceControl = serviceManager().control,
) => featureWords(await switchFeature(noFlags, dir, name, on, () => control));

test.skipIf(!spadeInThisRelease)(
  "with no daemon running, ace spade on|off registers or removes Spade's service and saves the setting",
  async ({ onTestFinished }) => {
    const dir = await home(onTestFinished, true);
    const manager = serviceManager();

    const on = await switchSpade(noFlags, dir, true, manager.control);
    expect(manager.asked).toEqual(["installBinary", "register"]);
    expect(await saved(dir, "spade.enabled")).toBe(true);
    expect(spadeSwitchWords(on)).toContain("once the ace daemon runs");

    // Already running: on again leaves the service alone.
    await switchSpade(noFlags, dir, true, manager.control);
    expect(manager.asked).toEqual(["installBinary", "register"]);

    await switchSpade(noFlags, dir, false, manager.control);
    expect(manager.state()).toBe("absent");
    expect(await saved(dir, "spade.enabled")).toBe(false);
  },
);

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

test.skipIf(!spadeInThisRelease)(
  "a daemon-endpoint left by a daemon that is gone still lets ace spade act without it",
  async ({ onTestFinished }) => {
    const dir = await home(onTestFinished, true);
    await writeFile(join(dir, "daemon-endpoint"), `http://127.0.0.1:${await closedPort()}`);
    await writeFile(join(dir, "daemon-token"), "t".repeat(64));
    const manager = serviceManager();
    await switchSpade(noFlags, dir, true, manager.control);
    expect(manager.asked).toEqual(["installBinary", "register"]);
    expect(await saved(dir, "spade.enabled")).toBe(true);
  },
);

test.skipIf(!spadeInThisRelease)(
  "a daemon that runs but doesn't answer is never worked around: ace spade fails and changes nothing",
  async ({ onTestFinished }) => {
    const dir = await home(onTestFinished, true);
    // A daemon still starting: it takes connections and answers none of them.
    const held: Socket[] = [];
    const starting = createServer((socket) => held.push(socket));
    starting.listen(0, "127.0.0.1");
    await once(starting, "listening");
    onTestFinished(async () => {
      for (const socket of held) socket.destroy();
      starting.close();
    });
    const address = starting.address();
    if (!address || typeof address === "string") throw new Error("No port");
    await writeFile(join(dir, "daemon-endpoint"), `http://127.0.0.1:${address.port}`);
    await writeFile(join(dir, "daemon-token"), "t".repeat(64));
    const manager = serviceManager();

    await expect(
      switchSpade({ words: [], flags: { timeout: "1s" } }, dir, true, manager.control),
    ).rejects.toThrow("running but didn't answer");
    expect(manager.asked).toEqual([]);
    expect(await saved(dir, "spade.enabled")).not.toBe(true);
  },
);

test.skipIf(!spadeInThisRelease)(
  "off a terminal, ace spade on is refused while Beta hides Spade, and changes nothing",
  async ({ onTestFinished }) => {
    const dir = await home(onTestFinished);
    const manager = serviceManager();
    const refused: unknown = await switchSpade(noFlags, dir, true, manager.control).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(CliFailure);
    expect(refused).toMatchObject({
      outcome: "refused",
      detail: { code: "turned_off", hint: expect.stringContaining("--yes") },
    });
    expect(manager.asked).toEqual([]);
    expect(await saved(dir, "beta.spade")).toBe(false);
  },
);

test.skipIf(!spadeInThisRelease)(
  "ace spade on --yes turns the Beta switch on too, then Spade",
  async ({ onTestFinished }) => {
    const dir = await home(onTestFinished);
    const manager = serviceManager();
    const result = await switchSpade(
      { words: [], flags: { yes: true } },
      dir,
      true,
      manager.control,
    );
    expect(result).toEqual({ enabled: true, live: false, beta: true });
    expect(await saved(dir, "beta.spade")).toBe(true);
    expect(await saved(dir, "spade.enabled")).toBe(true);
    expect(manager.asked).toEqual(["installBinary", "register"]);
  },
);

test.skipIf(!spadeInThisRelease)(
  "on a terminal, ace spade on asks once before turning Beta on, and a no changes nothing",
  async ({ onTestFinished }) => {
    const dir = await home(onTestFinished);
    const manager = serviceManager();
    let asked = 0;
    const answer = (yes: boolean) => async () => {
      asked++;
      return yes;
    };
    await expect(switchSpade(noFlags, dir, true, manager.control, answer(false))).rejects.toThrow(
      "Spade stays off",
    );
    expect(asked).toBe(1);
    expect(await saved(dir, "beta.spade")).toBe(false);
    expect(manager.asked).toEqual([]);

    const result = await switchSpade(noFlags, dir, true, manager.control, answer(true));
    expect(asked).toBe(2);
    expect(result.beta).toBe(true);
    expect(manager.asked).toEqual(["installBinary", "register"]);
    // Once Beta shows Spade, nothing is asked again.
    await switchSpade(noFlags, dir, true, manager.control, answer(true));
    expect(asked).toBe(2);
  },
);

test.skipIf(!spadeInThisRelease)(
  "ace feature off spade keeps Spade's own switch as it was",
  async ({ onTestFinished }) => {
    const dir = await home(onTestFinished);
    const manager = serviceManager();
    await feature(dir, "spade", true, manager.control);
    expect(await readFeatures(dir)).toMatchObject({ spade: true });
    await switchSpade(noFlags, dir, true, manager.control);
    expect(manager.asked).toEqual(["installBinary", "register"]);

    await feature(dir, "spade", false, manager.control);
    expect(await readFeatures(dir)).toMatchObject({ spade: false });
    expect(await saved(dir, "spade.enabled")).toBe(true);
  },
);

test("ace feature turns the marketplace on and off, and names the features for anything else", async ({
  onTestFinished,
}) => {
  const dir = await home(onTestFinished);
  expect(await readFeatures(dir)).toEqual({ spade: false, marketplace: false });
  expect(await feature(dir, "marketplace", true)).toBe("The marketplace is turned on.");
  expect(await readFeatures(dir)).toEqual({ spade: false, marketplace: true });
  expect(await feature(dir, "marketplace", false)).toContain("keeps working");
  expect(() => betaFeature("marketplac")).toThrow(
    expect.objectContaining({
      outcome: "usage",
      detail: expect.objectContaining({ hint: "Did you mean marketplace?" }),
    }),
  );
  expect(() => betaFeature("show")).toThrow("FEATURE must be spade or marketplace");
});

test.skipIf(!spadeInThisRelease)(
  "an old features.json that shows Spade still lets ace spade on through until it is moved",
  async ({ onTestFinished }) => {
    const dir = await home(onTestFinished);
    await writeFile(join(dir, "features.json"), '{"spade": true}');
    const manager = serviceManager();
    await switchSpade(noFlags, dir, true, manager.control);
    expect(manager.asked).toEqual(["installBinary", "register"]);
  },
);

test.skipIf(!spadeInThisRelease)(
  "with no daemon running, ace feature off spade stops Spade's service and keeps its data and switch",
  async ({ onTestFinished }) => {
    const dir = await home(onTestFinished, true);
    const manager = serviceManager();
    await switchSpade(noFlags, dir, true, manager.control);
    await writeFile(join(dir, "kept.txt"), "Spade's data");

    expect(await feature(dir, "spade", false, manager.control)).toContain("service was stopped");
    expect(manager.state()).toBe("absent");
    expect(await saved(dir, "spade.enabled")).toBe(true);
    expect(await readFile(join(dir, "kept.txt"), "utf8")).toBe("Spade's data");

    // With no service to stop, the words say only what happened.
    expect(await feature(dir, "spade", false, manager.control)).not.toContain("stopped");
  },
);

test.skipIf(spadeInThisRelease)(
  "in a release that keeps Spade off, ace spade on and ace feature on spade are refused and change nothing",
  async ({ onTestFinished }) => {
    const dir = await home(onTestFinished);
    const manager = serviceManager();
    const attempts: (() => Promise<unknown>)[] = [
      () => switchSpade({ words: [], flags: { yes: true } }, dir, true, manager.control),
      () => switchFeature(noFlags, dir, "spade", true, () => manager.control),
    ];
    for (const attempt of attempts) {
      const refused: unknown = await attempt().catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(CliFailure);
      expect(refused).toMatchObject({
        outcome: "refused",
        message: "Spade isn't available in this release of ace.",
      });
    }
    expect(manager.asked).toEqual([]);
    expect(await saved(dir, "beta.spade")).toBe(false);
    expect(await saved(dir, "spade.enabled")).toBe(false);
    // Turning it off still works, so a machine that had it on can tidy up.
    await switchFeature(noFlags, dir, "spade", false, () => manager.control);
    expect(await saved(dir, "beta.spade")).toBe(false);
  },
);
