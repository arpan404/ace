import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ProviderStatus } from "@ace/protocol";
import { ModelCatalog, openModelStorage } from "@ace/models";
import { ProviderStatuses } from "./provider-status.ts";
import { applyInstallations } from "./installation-gate.ts";
import { scriptedModelDiscovery, scriptedModelInstance } from "./testing/models.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * Statuses with a clock the test moves and timers it fires. With `codexVersion`, PATH holds a
 * `codex` whose probes answer with that version (read at each probe) and a signed-in login;
 * otherwise PATH has no CLIs.
 */
async function statuses(
  codexVersion?: { current: string },
  /** What the daemon does with each check's rows; the model catalog's installations here. */
  onChecked?: (rows: readonly ProviderStatus[]) => void,
) {
  const home = await mkdtemp(join(tmpdir(), "ace-provider-cadence-"));
  const bin = join(home, "bin");
  if (codexVersion) {
    await mkdir(bin);
    await writeFile(join(bin, "codex"), "");
    await chmod(join(bin, "codex"), 0o755);
  }
  const checked: ProviderStatus[][] = [];
  const clock = { now: 1_000 };
  const timers = new Map<() => void, number>();
  let checks = 0;
  const subject = new ProviderStatuses(
    {
      env: { HOME: home, PATH: codexVersion ? bin : "" },
      // The CLI is never run: the probe answers as an installed codex would.
      probe: async (_command, args) => ({
        code: 0,
        stderr: "",
        stdout:
          args[0] === "--version"
            ? `codex-cli ${codexVersion?.current}`
            : "Logged in using ChatGPT",
      }),
      cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "unused" }),
      antigravity: async () => ({ installed: false, auth: "unknown", loginHint: "unused" }),
      checked: (rows) => {
        checks++;
        checked.push([...rows]);
        onChecked?.(rows);
      },
    },
    {
      now: () => clock.now,
      schedule(callback, milliseconds) {
        timers.set(callback, milliseconds);
        return () => timers.delete(callback);
      },
    },
  );
  cleanups.push(async () => {
    await subject.close();
    await rm(home, { recursive: true, force: true });
  });
  await subject.firstCheck();
  const settle = async () => {
    // A check started by a listener or a read settles on its own; wait for it to publish.
    await expect.poll(() => subject.list().every((row) => !row.refreshing)).toBe(true);
  };
  return {
    subject,
    clock,
    timers,
    checks: () => checks,
    /** The codex row each check reported to the daemon (which feeds the model catalog). */
    codex: () => checked.at(-1)?.find((row) => row.provider === "codex"),
    settle,
    fire() {
      const pending = [...timers.keys()];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
}

test("no provider CLI is checked on a timer while no client listens", async () => {
  const { timers, checks } = await statuses();
  expect(checks()).toBe(1);
  expect([...timers.values()]).toEqual([]);
});

test("a listening client gets a check every five minutes until it leaves", async () => {
  const status = await statuses();
  status.clock.now += 60_000;
  const stop = status.subject.listen(() => {});
  // The first check is a minute old: the next one is due in the remaining four.
  expect([...status.timers.values()]).toEqual([240_000]);
  status.clock.now += 240_000;
  status.fire();
  await status.settle();
  expect(status.checks()).toBe(2);
  expect([...status.timers.values()]).toEqual([300_000]);
  stop();
  expect([...status.timers.values()]).toEqual([]);
});

test("a client attaching after a long gap gets a check at once", async () => {
  const status = await statuses();
  status.clock.now += 3_600_000;
  status.subject.listen(() => {});
  await status.settle();
  expect(status.checks()).toBe(2);
  expect(status.subject.list().every((row) => !row.stale)).toBe(true);
});

test("a stale read with nobody listening answers at once and checks again behind it", async () => {
  const status = await statuses();
  status.clock.now += 300_000;
  const rows = status.subject.list();
  expect(rows.every((row) => row.stale)).toBe(true);
  await status.settle();
  expect(status.checks()).toBe(2);
  expect(status.subject.list().every((row) => !row.stale)).toBe(true);
  expect([...status.timers.values()]).toEqual([]);
});

test("an outdated CLI keeps being checked with no client, so an update outside ace is seen", async () => {
  const codex = { current: "0.100.0" };
  const status = await statuses(codex);
  expect(status.codex()).toMatchObject({ version: "0.100.0", versionCheck: { status: "too_old" } });
  // Nobody listens, yet the next check is due: a scheduled or remote run is waiting on it.
  expect([...status.timers.values()]).toEqual([300_000]);
  codex.current = "0.170.0";
  status.clock.now += 300_000;
  status.fire();
  await status.settle();
  expect(status.codex()).toMatchObject({ version: "0.170.0", versionCheck: { status: "ok" } });
  expect(status.subject.installations()).toContainEqual(
    expect.objectContaining({ provider: "codex", version: "0.170.0" }),
  );
  // Supported now and nobody listening: no more checks on a timer.
  expect([...status.timers.values()]).toEqual([]);
});

test("the last client leaving keeps the timer while a CLI is outdated", async () => {
  const status = await statuses({ current: "0.100.0" });
  const stop = status.subject.listen(() => {});
  stop();
  expect([...status.timers.values()]).toEqual([300_000]);
});

test("a status check that sees an updated CLI lifts the model catalog's too-old hold", async () => {
  const codex = { current: "0.100.0" };
  let catalog: ModelCatalog | undefined;
  const status = await statuses(codex, (rows) => {
    if (catalog) applyInstallations(catalog, rows);
  });
  const home = await mkdtemp(join(tmpdir(), "ace-provider-cadence-catalog-"));
  catalog = new ModelCatalog({
    storage: openModelStorage(join(home, "models.sqlite")),
    instances: [scriptedModelInstance("codex", home)],
    discover: scriptedModelDiscovery(),
    now: () => status.clock.now,
    deadline: () => () => {},
  });
  cleanups.push(async () => {
    await catalog?.close();
    await rm(home, { recursive: true, force: true });
  });
  // The startup check's version, as the daemon hands it over.
  applyInstallations(catalog, status.subject.installations());
  await expect.poll(() => catalog?.list().instances[0]?.errorDetail?.code).toBe("cli_too_old");
  // Its own retries wait hours on an unchanged too-old version.
  status.clock.now += 300_000;
  catalog.revalidate();
  expect(catalog.list().models).toEqual([]);
  // Updated outside ace, with no client attached: the next status check carries it over.
  codex.current = "0.170.0";
  status.fire();
  await status.settle();
  await expect
    .poll(() => catalog?.list().models.map((model) => model.id))
    .toEqual(["chosen-model"]);
  expect(catalog.list().instances[0]?.errorDetail).toBeUndefined();
});

test("admission's freshness check runs a CLI check only when the facts are five minutes old", async () => {
  const status = await statuses();
  status.clock.now += 299_000;
  await status.subject.fresh();
  expect(status.checks()).toBe(1);
  status.clock.now += 1_000;
  await Promise.all([status.subject.fresh(), status.subject.fresh()]);
  // Two delegations at once share one check.
  expect(status.checks()).toBe(2);
});
