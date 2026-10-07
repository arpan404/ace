import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  ModelCatalog,
  openModelStorage,
  normalizeCodex,
  discoveryError,
  type CatalogOptions,
  type DiscoverModels,
} from "./index.ts";
import type { ModelSourceStatus, ProviderConfigurations } from "@ace/protocol";
import { Clock, codexPayload, instance, workspace } from "./testing/support.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function setup(discover: DiscoverModels, extra: Partial<CatalogOptions> = {}) {
  const work = await workspace();
  cleanup.push(work.close);
  const clock = new Clock();
  const notices: {
    source?: string | undefined;
    code: string;
    level?: string | undefined;
    retryInMs?: number | undefined;
  }[] = [];
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(work.path, "models.sqlite")),
    instances: [{ ...instance("opencode"), cwd: work.path }],
    discover,
    now: () => clock.now,
    deadline: clock.deadline,
    random: () => 0.5,
    onError: (_provider, _instance, error, source, diagnostic) => {
      notices.push({
        source,
        code: error.code,
        level: diagnostic?.level,
        retryInMs: diagnostic?.retryInMs,
      });
    },
    ...extra,
  });
  cleanup.push(() => catalog.close());
  return { catalog, clock, notices };
}
function automatic(catalog: ModelCatalog): Promise<void> {
  return new Promise((resolve) => {
    const stop = catalog.listen(() => {
      if (catalog.list().instances.every((status) => !status.refreshing)) {
        stop();
        resolve();
      }
    });
    catalog.revalidate();
  });
}
const fail = async () => {
  throw Object.assign(new Error("synthetic offline"), { status: 503 });
};

test("automatic failures double their delay, cap at thirty minutes, and stop warning for unchanged capped failures", async () => {
  const { catalog, clock, notices } = await setup(fail, { revisionProbe: async () => "same" });
  await catalog.refresh();
  for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]) {
    expect(notices.at(-1)?.retryInMs).toBe(delay);
    const count = notices.length;
    clock.now += delay - 1;
    catalog.revalidate();
    await catalog.reconcileConnections();
    expect(catalog.list().instances[0]).toMatchObject({
      refreshing: false,
      errorDetail: { code: "unreachable" },
    });
    expect(notices).toHaveLength(count);
    clock.now++;
    await automatic(catalog);
  }
  expect(notices.map((notice) => notice.level)).toEqual([
    "warn",
    "warn",
    "warn",
    "warn",
    "warn",
    "warn",
    "warn",
    "debug",
    "debug",
  ]);
});

test.each([0, 1])(
  "jitter changes automatic eligibility without exceeding the thirty-minute cap (%s)",
  async (random) => {
    const { catalog, clock, notices } = await setup(fail, { random: () => random });
    await catalog.refresh();
    const delay = random === 0 ? 24_000 : 36_000;
    expect(notices.at(-1)?.retryInMs).toBe(delay);
    clock.now += delay - 1;
    catalog.revalidate();
    expect(catalog.list().instances[0]?.refreshing).toBe(false);
    clock.now++;
    await automatic(catalog);
    expect(notices.at(-1)?.retryInMs).toBe(delay * 2);
  },
);

test.each(["refresh", "login", "settings", "version", "connections"] as const)(
  "%s changes allow immediate discovery and restart the failure schedule",
  async (reset) => {
    let fingerprint = "original";
    let preferences: ProviderConfigurations = [];
    const { catalog, clock, notices } = await setup(fail, {
      preferences: () => preferences,
      revisionProbe: async () => fingerprint,
    });
    await catalog.reconcileConnections();
    clock.now += 30_000;
    await automatic(catalog);
    expect(notices.at(-1)?.retryInMs).toBe(60_000);
    if (reset === "refresh") await catalog.refresh();
    if (reset === "login") await catalog.loginChanged("opencode", "new-login");
    if (reset === "connections") {
      fingerprint = "new";
      await catalog.reconcileConnections();
    }
    if (reset === "settings" || reset === "version") {
      const completed = new Promise<void>((resolve) => {
        const stop = catalog.listen(() => {
          if (notices.length === 3 && !catalog.list().instances[0]?.refreshing) {
            stop();
            resolve();
          }
        });
      });
      if (reset === "settings") {
        preferences = [{ provider: "opencode", binaryPath: "/synthetic/new-opencode" }];
        catalog.configurationChanged();
      } else catalog.installationChanged("opencode", "2.0.23");
      await completed;
    }
    expect(notices).toHaveLength(3);
    expect(notices.at(-1)).toMatchObject({ retryInMs: 30_000, level: "warn" });
  },
);

test("success clears instance failure history and a later failure starts at thirty seconds", async () => {
  let failing = true;
  const { catalog, clock, notices } = await setup(
    async (config) => {
      if (failing) return fail();
      return normalizeCodex(codexPayload(), { ...config, provider: "codex" }).map((model) =>
        Object.assign({}, model, { provider: "opencode" as const }),
      );
    },
    { ttlMs: 30_000 },
  );
  await catalog.refresh();
  clock.now += 30_000;
  await automatic(catalog);
  failing = false;
  clock.now += 60_000;
  await automatic(catalog);
  expect(catalog.list().instances[0]?.stale).toBe(false);
  expect(catalog.list().instances[0]?.errorDetail).toBeUndefined();
  failing = true;
  clock.now += 30_000;
  await automatic(catalog);
  expect(notices.map((notice) => notice.retryInMs)).toEqual([30_000, 60_000, 30_000]);
});

test("partial failures retain independent source schedules and a recovered source starts over", async () => {
  let round = 0;
  const { catalog, clock, notices } = await setup(async () => {
    round++;
    const sources: ModelSourceStatus[] = ["a", "b"].map((id): ModelSourceStatus => {
      const error =
        (id === "a" && round !== 3) || (id === "b" && round > 1)
          ? discoveryError({ status: 401 })
          : undefined;
      return Object.assign(
        {
          source: { id, kind: "other" as const, label: id },
          status: error ? ("stale" as const) : ("fresh" as const),
        },
        error ? { error } : {},
      );
    });
    return Object.assign([], { sources });
  });
  await catalog.refresh();
  for (const delay of [30_000, 60_000, 60_000]) {
    clock.now += delay;
    await automatic(catalog);
  }
  expect(
    notices.filter((notice) => notice.source === "a").map((notice) => notice.retryInMs),
  ).toEqual([30_000, 60_000, 30_000]);
  expect(
    notices.filter((notice) => notice.source === "b").map((notice) => notice.retryInMs),
  ).toEqual([30_000, 60_000, 120_000]);
});

test("failing connection probes back off too and explicit refresh clears their cooldown", async () => {
  const { catalog, clock, notices } = await setup(fail, { revisionProbe: fail });
  await catalog.reconcileConnections();
  clock.now += 29_999;
  await catalog.reconcileConnections();
  expect(notices).toHaveLength(1);
  clock.now++;
  await catalog.reconcileConnections();
  expect(notices.at(-1)?.retryInMs).toBe(60_000);
  await catalog.refresh();
  await catalog.reconcileConnections();
  expect(notices).toHaveLength(4);
});

test("jitter does not turn capped repeats into warnings but a changed failure reason does", async () => {
  let status = 503;
  let jitter = 0;
  const { catalog, clock, notices } = await setup(
    async () => {
      throw { status };
    },
    {
      retryMs: 1_800_000,
      random: () => jitter,
    },
  );
  await catalog.refresh();
  clock.now += 1_440_000;
  jitter = 1;
  await automatic(catalog);
  expect(notices.at(-1)).toMatchObject({ level: "debug", retryInMs: 1_800_000 });
  clock.now += 1_800_000;
  status = 401;
  await automatic(catalog);
  expect(notices.at(-1)).toMatchObject({
    level: "warn",
    code: "auth_expired",
    retryInMs: 1_800_000,
  });
});

test("a timed-out connection probe reports timeout and avoids another probe until eligible", async () => {
  const started = Promise.withResolvers<void>();
  const { catalog, clock, notices } = await setup(fail, {
    revisionProbe: async (_config, signal) => {
      started.resolve();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return "unreachable";
    },
  });
  const probe = catalog.reconcileConnections();
  await started.promise;
  clock.expire();
  await probe;
  expect(notices).toEqual([
    { source: undefined, code: "timeout", level: "warn", retryInMs: 30_000 },
  ]);
  await catalog.reconcileConnections();
  expect(catalog.list().instances[0]).toMatchObject({
    refreshing: false,
    errorDetail: { code: "timeout" },
  });
  expect(notices).toHaveLength(1);
});

test("a first GitHub Copilot failure shows its reconnect hint even before any catalog was saved", async () => {
  const { catalog } = await setup(async (_config, _signal, diagnostic) => {
    diagnostic?.({
      sources: [{ id: "github-copilot", label: "GitHub Copilot", kind: "subscription" }],
    });
    throw { status: 403, message: "private Bearer token" };
  });
  await catalog.refresh();
  const result = catalog.list();
  expect(result.instances[0]?.errorDetail).toMatchObject({
    code: "auth_expired",
    hint: expect.stringContaining("Reconnect GitHub Copilot in OpenCode (`opencode auth login`)"),
  });
  expect(JSON.stringify(result)).not.toMatch(/private|Bearer|token/);
});
