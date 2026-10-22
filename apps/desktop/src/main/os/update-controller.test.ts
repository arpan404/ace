import { expect, it } from "vitest";
import type { UpdateStatus } from "../../shared/contract.ts";
import {
  scheduleChecks,
  stalledMessage,
  UpdateController,
  type UpdateEngine,
} from "./update-controller.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const notes = [{ version: "1.1.0", items: ["Faster startup (#985)"], total: 1 }];
const releaseUrl = "https://github.com/arpan404/ace/releases/tag/v1.1.0";

/** A release feed and installer the test steers; the app's own effects are recorded. */
function setup(
  options: { found?: string; canInstall?: boolean; drained?: boolean; busy?: number | Error } = {},
) {
  const reported: UpdateStatus[] = [];
  const effects: string[] = [];
  let found = options.found;
  let checkError: Error | undefined;
  let checkGate: Promise<void> | undefined;
  let requests = 0;
  let downloads = 0;
  let progress: ((percent: number) => void) | undefined;
  let finishDownload: (() => void) | undefined;
  let failDownload: ((error: Error) => void) | undefined;
  let drainWaiting: ((count: number) => void) | undefined;
  let finishDrain: ((drained: boolean) => void) | undefined;
  const engine: UpdateEngine = {
    canInstall: options.canInstall ?? true,
    check: async () => {
      requests += 1;
      if (checkGate) await checkGate;
      if (checkError) throw checkError;
      return found ? { version: found, notes, olderReleases: 0 } : undefined;
    },
    download: (report) => {
      downloads += 1;
      progress = report;
      return new Promise<void>((resolve, reject) => {
        finishDownload = resolve;
        failDownload = reject;
      });
    },
    install: () => effects.push("install"),
  };
  const controller = new UpdateController({
    engine,
    version: "1.0.0",
    enabled: true,
    releaseUrl: (version) => `https://github.com/arpan404/ace/releases/tag/v${version}`,
    drain: (waiting) => {
      effects.push("drain");
      drainWaiting = waiting;
      if (options.drained !== undefined) return Promise.resolve(options.drained);
      return new Promise((resolve) => (finishDrain = resolve));
    },
    busy: () =>
      options.busy instanceof Error
        ? Promise.reject(options.busy)
        : Promise.resolve(options.busy ?? 0),
    prepareQuit: async () => {
      effects.push("stop daemon");
    },
    quit: () => effects.push("quit"),
    report: (status) => reported.push(status),
    log: () => {},
  });
  return {
    controller,
    reported,
    effects,
    states: () => reported.map((status) => status.state),
    now: () => controller.current(),
    progress: (percent: number) => progress?.(percent),
    finishDownload: async () => {
      finishDownload?.();
      await settle();
    },
    failDownload: async (error: Error) => {
      failDownload?.(error);
      await settle();
    },
    agentsStillWorking: (count: number) => drainWaiting?.(count),
    finishDrain: async (drained: boolean) => {
      finishDrain?.(drained);
      await settle();
    },
    feed: (version: string | undefined) => (found = version),
    offline: (error: Error | undefined) => (checkError = error),
    feedRequests: () => requests,
    downloads: () => downloads,
    holdCheck: () => {
      const gate = Promise.withResolvers<void>();
      checkGate = gate.promise;
      return gate.resolve;
    },
  };
}

/** Found, downloaded and waiting for Restart. */
async function downloaded(app: ReturnType<typeof setup>) {
  await app.controller.check("background");
  const downloading = app.controller.download();
  await app.finishDownload();
  await downloading;
}

it("a found update is offered with its release notes, and nothing downloads until asked", async () => {
  const app = setup({ found: "1.1.0" });
  await app.controller.check("background");
  expect(app.now()).toMatchObject({
    state: "available",
    currentVersion: "1.0.0",
    version: "1.1.0",
    releaseUrl,
    inPlace: true,
    notes,
  });
  expect(app.downloads()).toBe(0);
});

it("downloading reports whole-percent progress, then waits as downloaded", async () => {
  const app = setup({ found: "1.1.0" });
  await app.controller.check("background");
  const downloading = app.controller.download();
  app.progress(41.7);
  app.progress(41.9);
  app.progress(88);
  await app.finishDownload();
  await downloading;
  expect(app.reported.map((status) => [status.state, status.percent])).toEqual([
    ["available", null],
    ["downloading", 0],
    ["downloading", 41],
    ["downloading", 88],
    ["downloaded", 100],
  ]);
  expect(app.effects).toEqual([]);
});

it("a failed download keeps the update on offer to retry, saying why", async () => {
  const app = setup({ found: "1.1.0" });
  await app.controller.check("background");
  const downloading = app.controller.download();
  await app.failDownload(new Error("net::ERR_CONNECTION_RESET"));
  await downloading;
  expect(app.now()).toMatchObject({
    state: "available",
    version: "1.1.0",
    error: { during: "download", message: "net::ERR_CONNECTION_RESET" },
  });
  void app.controller.download();
  expect(app.downloads()).toBe(2);
});

it("an update this app can't install itself is never downloaded; its release page is offered", async () => {
  const app = setup({ found: "1.1.0", canInstall: false });
  await app.controller.check("background");
  await app.controller.download();
  expect(app.now()).toMatchObject({ state: "available", inPlace: false, releaseUrl });
  expect(app.downloads()).toBe(0);
});

it("a person's check shows checking, then up to date or why it failed", async () => {
  const app = setup();
  await app.controller.check("person");
  app.offline(new Error("The update check timed out."));
  await app.controller.check("person");
  expect(app.reported.map((status) => [status.state, status.error?.message ?? null])).toEqual([
    ["checking", null],
    ["current", null],
    ["checking", null],
    ["error", "The update check timed out."],
  ]);
});

it("background checks never show checking, and their failures change nothing", async () => {
  const app = setup({ found: "1.1.0" });
  await app.controller.check("background");
  app.offline(new Error("offline"));
  await app.controller.check("background");
  expect(app.states()).not.toContain("checking");
  expect(app.now()).toMatchObject({ state: "available", version: "1.1.0", error: null });
});

it("a downloaded update stays ready through later checks", async () => {
  const app = setup({ found: "1.1.0" });
  await downloaded(app);
  await app.controller.check("person");
  app.feed(undefined);
  await app.controller.check("background");
  expect(app.now()).toMatchObject({ state: "downloaded", version: "1.1.0" });
});

it.each(["same release", "newer release", "no update", "failure"] as const)(
  "Download waits for a pending background check returning %s",
  async (result) => {
    const app = setup({ found: "1.1.0" });
    await app.controller.check("background");
    const releaseCheck = app.holdCheck();
    const checking = app.controller.check("background");
    const downloading = app.controller.download();
    expect(app.downloads()).toBe(0);
    if (result === "newer release") app.feed("1.2.0");
    if (result === "no update") app.feed(undefined);
    if (result === "failure") app.offline(new Error("offline"));
    releaseCheck();
    await checking;
    await settle();
    if (result === "no update") {
      await downloading;
      expect(app.now().state).toBe("current");
      expect(app.downloads()).toBe(0);
      return;
    }
    expect(app.now()).toMatchObject({
      state: "downloading",
      version: result === "newer release" ? "1.2.0" : "1.1.0",
    });
    app.progress(42);
    await app.controller.download();
    expect(app.now().percent).toBe(42);
    expect(app.downloads()).toBe(1);
    await app.finishDownload();
    await downloading;
    expect(app.now().state).toBe("downloaded");
  },
);

it.each(["same release", "no update", "failure"] as const)(
  "Restart waits for a pending background check returning %s, then stops the daemon once",
  async (result) => {
    const app = setup({ found: "1.1.0" });
    await downloaded(app);
    const releaseCheck = app.holdCheck();
    const checking = app.controller.check("background");
    const installing = app.controller.install();
    expect(app.effects).toEqual([]);
    if (result === "no update") app.feed(undefined);
    if (result === "failure") app.offline(new Error("offline"));
    releaseCheck();
    await checking;
    await installing;
    await app.controller.install();
    expect(app.effects).toEqual(["stop daemon", "install"]);
  },
);

it("the person's Restart stops running agents at once instead of waiting for them", async () => {
  const app = setup({ found: "1.1.0", busy: 2 });
  await downloaded(app);
  expect(await app.controller.busy()).toBe(2);
  await app.controller.install();
  expect(app.now().state).toBe("installing");
  expect(app.effects).toEqual(["stop daemon", "install"]);
});

it("an agent count the daemon can't give is unknown, not zero", async () => {
  const app = setup({ found: "1.1.0", busy: new Error("daemon gone") });
  expect(await app.controller.busy()).toBeUndefined();
});

it("ace update apply waits for running agents, then stops the daemon before installing", async () => {
  const app = setup({ found: "1.1.0" });
  await downloaded(app);
  const applying = app.controller.apply();
  await settle();
  app.agentsStillWorking(2);
  app.agentsStillWorking(1);
  expect(app.effects).toEqual(["drain"]);
  expect(app.now()).toMatchObject({ state: "installing", waiting: 1 });
  await app.finishDrain(true);
  await applying;
  expect(app.effects).toEqual(["drain", "stop daemon", "install"]);
});

it("agents still working at apply's deadline keep the update downloaded and the app running", async () => {
  const app = setup({ found: "1.1.0", drained: false });
  await downloaded(app);
  await app.controller.apply();
  expect(app.now()).toMatchObject({
    state: "downloaded",
    error: { during: "install", message: stalledMessage },
  });
  expect(app.effects).toEqual(["drain"]);
});

it("ace update apply finds, downloads and installs in one go", async () => {
  const app = setup({ found: "1.1.0", drained: true });
  const applying = app.controller.apply();
  await settle();
  await app.finishDownload();
  await applying;
  expect(app.states()).toEqual([
    "checking",
    "available",
    "downloading",
    "downloaded",
    "installing",
  ]);
  expect(app.effects).toEqual(["drain", "stop daemon", "install"]);
});

it("ace update apply with nothing newer installs nothing later", async () => {
  const app = setup({ drained: true });
  await app.controller.apply();
  app.feed("1.1.0");
  await downloaded(app);
  expect(app.now().state).toBe("downloaded");
  expect(app.effects).toEqual([]);
});

it("a build without the release feed never asks it", async () => {
  const reported: UpdateStatus[] = [];
  const controller = new UpdateController({
    engine: {
      canInstall: true,
      check: () => Promise.reject(new Error("asked")),
      download: () => Promise.resolve(),
      install: () => {},
    },
    version: "1.0.0",
    enabled: false,
    releaseUrl: () => "",
    drain: () => Promise.resolve(true),
    busy: () => Promise.resolve(0),
    prepareQuit: () => Promise.resolve(),
    quit: () => {},
    report: (status) => reported.push(status),
    log: () => {},
  });
  expect((await controller.check("person")).state).toBe("disabled");
  expect(reported).toEqual([]);
});

it("background checks ask the feed after launch settles and then periodically, each wait offset at random", async () => {
  const app = setup();
  const pending: { delayMs: number; callback: () => void }[] = [];
  const draws = [0, 0.5, 1];
  scheduleChecks(
    app.controller,
    {
      set(delayMs, callback) {
        pending.push({ delayMs, callback });
        return () => {};
      },
    },
    () => draws.shift() ?? 0,
    () => 0,
    { firstMs: 10_000, everyMs: 1_800_000, spread: 0.5, openGapMs: 30_000 },
  );
  expect(pending.map((timer) => timer.delayMs)).toEqual([10_000]);
  expect(app.feedRequests()).toBe(0);
  pending[0]?.callback();
  await settle();
  pending[1]?.callback();
  await settle();
  expect(app.feedRequests()).toBe(2);
  // Each wait is its base plus up to half again, by the random draw.
  expect(pending.map((timer) => timer.delayMs)).toEqual([10_000, 2_250_000, 2_700_000]);
});

/** Scheduled checks on fake timers and a fake clock, for opening the app. */
function openingApp() {
  const app = setup();
  let clock = 0;
  const pending = new Set<{ delayMs: number; callback: () => void }>();
  const schedule = scheduleChecks(
    app.controller,
    {
      set(delayMs, callback) {
        const timer = { delayMs, callback };
        pending.add(timer);
        return () => pending.delete(timer);
      },
    },
    () => 0,
    () => clock,
    { firstMs: 15_000, everyMs: 60_000, spread: 0.5, openGapMs: 30_000 },
  );
  return {
    app,
    schedule,
    advance: (ms: number) => (clock += ms),
    waits: () => [...pending].map((timer) => timer.delayMs),
  };
}

it("opening the app checks for an update at once, without waiting for launch's first check", async () => {
  const { app, schedule, waits } = openingApp();
  expect(app.feedRequests()).toBe(0);

  schedule.opened();
  await settle();

  expect(app.feedRequests()).toBe(1);
  // The launch timer is replaced: the next check is a full period after this one.
  expect(waits()).toEqual([60_000]);
});

it("opening the app again right after a check asks the feed only once", async () => {
  const { app, schedule, advance } = openingApp();
  schedule.opened();
  await settle();
  advance(5_000);
  schedule.opened();
  await settle();
  expect(app.feedRequests()).toBe(1);

  advance(30_000);
  schedule.opened();
  await settle();
  expect(app.feedRequests()).toBe(2);
});
