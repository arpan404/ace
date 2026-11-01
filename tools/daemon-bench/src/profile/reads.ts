/**
 * Read paths on a clone of real ace data, against the bundled daemon: cold start, first
 * sidebar, opening long threads, paging history and search. No provider can start: HOME is a
 * throwaway directory, PATH is an empty directory, and the clone holds only events.sqlite.
 *
 * Make the clone with APFS clonefile (no copy, no extra disk until pages diverge):
 *   mkdir -p /tmp/ace-rust-case/real/home/.ace-real && cd $_ &&
 *   cp -c ~/.ace/events.sqlite ~/.ace/events.sqlite-wal ~/.ace/events.sqlite-shm . &&
 *   cp ~/.ace/ace-format.json .
 * Without ace-format.json the daemon treats the folder as a pre-v1 home and moves it aside
 * (to `<name>-v0`) before starting fresh.
 *
 * node tools/daemon-bench/src/profile/reads.ts --entry=DIR/ace.mjs --home=/tmp/…/real/home
 *   [--ace-home=.ace-real] [--node=PATH] [--out=DIR] [--mode=plain|v8|native] [--reps=5]
 *
 * `native` repeats each read for 10 s under macOS `sample` and splits the daemon's time into
 * SQLite, JSON, GC and JavaScript; `v8` attributes JavaScript frames to source files.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import { footprint, startDaemon, type RunningDaemon } from "../daemon.ts";
import { Driver, until } from "../driver.ts";
import { Inspector } from "../inspector.ts";
import { attribute } from "./attribute.ts";
import { nativeSplit } from "./native.ts";
import { count, option } from "./args.ts";

const entry = resolve(option("entry") ?? "");
const home = resolve(option("home") ?? "/tmp/ace-rust-case/real/home");
const aceHome = join(home, option("ace-home") ?? ".ace-real");
const out = resolve(option("out") ?? "/tmp/ace-rust-case/reads");
const node = option("node");
const mode = option("mode") ?? "plain";
const reps = count("reps", 5);
const log = (line: string) => process.stderr.write(`reads: ${line}\n`);
await mkdir(out, { recursive: true });
const bin = join(home, "empty-bin");
await mkdir(bin, { recursive: true });
await mkdir(join(home, "tmp"), { recursive: true });

const longest = (() => {
  const db = new DatabaseSync(join(aceHome, "events.sqlite"), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT thread_id AS id, count(*) AS items FROM items GROUP BY thread_id ORDER BY items DESC LIMIT 5",
      )
      .all()
      .map((row) => ({ id: String(row["id"]), items: Number(row["items"]) }));
  } finally {
    db.close();
  }
})();

const settings = {
  entry,
  root: { home, aceHome, bin, project: home, tmp: join(home, "tmp") },
  fixtures: "/nonexistent",
  speed: 20,
  deltaMs: 10,
  ...(node ? { node } : {}),
};
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
const results: Record<string, unknown> = { entry, node: node ?? process.execPath, longest };

let daemon: RunningDaemon | undefined;
let inspector: Inspector | undefined;
let unwatchLast = () => {};
/** Every command the daemon spawned, and a hard stop if any could touch real repos or CLIs. */
const children = new Set<string>();
const forbidden =
  /\b(git|claude|codex|cursor|cursor-agent|opencode|gemini|pi|agy|antigravity|gh|ssh)\b/;
const watch = (pid: number) => {
  const timer = setInterval(() => {
    void promisify(execFile)("/bin/ps", ["-A", "-o", "ppid=,comm="]).then(({ stdout }) => {
      for (const line of stdout.split("\n")) {
        const [ppid, ...rest] = line.trim().split(/\s+/);
        if (Number(ppid) !== pid) continue;
        const command = rest.join(" ");
        children.add(command);
        if (forbidden.test(command.split("/").at(-1) ?? "")) {
          log(`STOP: daemon spawned ${command}`);
          process.kill(pid, "SIGKILL");
          process.exit(3);
        }
      }
    });
  }, 250);
  return () => clearInterval(timer);
};
try {
  // Cold starts: spawn to endpoint, and to the first sidebar a fresh client is served.
  const starts: { endpointMs: number; sidebarMs: number; load: number }[] = [];
  for (let rep = 0; rep < reps; rep++) {
    const spawned = performance.now();
    const started = await startDaemon(settings);
    const endpointMs = performance.now() - spawned;
    const unwatch = watch(started.pid);
    const driver = await Driver.connect(started.origin, started.token);
    const lease = driver.client.threads();
    await until(
      lease.store.select(["ids"], (store) => store.loaded && !store.syncing),
      Boolean,
      "the sidebar",
    );
    starts.push({ endpointMs, sidebarMs: performance.now() - spawned, load: loadavg()[0] ?? 0 });
    lease.release();
    await driver.close();
    if (rep < reps - 1) {
      await started.stop();
      unwatch();
    } else {
      daemon = started;
      unwatchLast = unwatch;
    }
  }
  results["startup"] = {
    runs: starts,
    endpointMedianMs: median(starts.map((run) => run.endpointMs)),
    sidebarMedianMs: median(starts.map((run) => run.sidebarMs)),
  };
  if (!daemon) throw new Error("No daemon");
  inspector = await Inspector.connect(daemon.inspectorUrl);
  const probe = inspector;
  const running = daemon;
  await pause(5000);
  results["idleAfterStart"] = {
    ...(await probe.collected()),
    footprint: await footprint(running.pid),
  };

  /** Runs `body` `times` times, measuring client wall time and daemon CPU per run. */
  const measure = async (name: string, times: number, body: (index: number) => Promise<void>) => {
    log(name);
    if (mode === "v8") await probe.profileStart(250);
    const runs: { wallMs: number; cpuMs: number }[] = [];
    if (mode === "native") {
      const file = join(out, `${name}.sample.txt`);
      const sampling = promisify(execFile)("/usr/bin/sample", [
        String(running.pid),
        "10",
        "1",
        "-file",
        file,
      ]);
      const state = { done: false };
      void sampling.finally(() => {
        state.done = true;
      });
      for (let index = 0; !state.done; index++) await body(index % times);
      await sampling;
      const split = nativeSplit([file]);
      results[name] = { load: loadavg()[0], split: split.threads.slice(0, 2) };
      return;
    }
    for (let index = 0; index < times; index++) {
      const before = await probe.counters();
      const started = performance.now();
      await body(index);
      const wallMs = performance.now() - started;
      const after = await probe.counters();
      runs.push({ wallMs, cpuMs: (after.cpuMicros - before.cpuMicros) / 1000 });
    }
    let profile: unknown;
    if (mode === "v8") {
      const path = join(out, `${name}.cpuprofile`);
      await writeFile(path, JSON.stringify(await probe.profileStop()));
      const attributed = attribute(path, resolve(entry, ".."));
      profile = {
        busyMs: attributed.busyMs,
        categories: attributed.categories.slice(0, 14),
        inclusive: attributed.inclusive,
        functions: attributed.functions.slice(0, 25),
      };
    }
    results[name] = {
      runs,
      wallMedianMs: median(runs.map((run) => run.wallMs)),
      cpuMedianMs: median(runs.map((run) => run.cpuMs)),
      load: loadavg()[0],
      ...(profile ? { profile } : {}),
    };
  };

  const fresh = () => Driver.connect(running.origin, running.token);
  await measure("sidebar", reps, async () => {
    const driver = await fresh();
    const lease = driver.client.threads();
    await until(
      lease.store.select(["ids"], (store) => store.loaded && !store.syncing),
      Boolean,
      "the sidebar",
    );
    lease.release();
    await driver.close();
  });

  const openThread = async (id: string) => {
    const driver = await fresh();
    const lease = driver.client.thread(id);
    await until(
      lease.store.select(
        ["thread", "order", "sync"],
        (store) => Boolean(store.thread) && store.order.length > 0 && !store.syncing,
      ),
      Boolean,
      `thread ${id}`,
    );
    lease.release();
    await driver.close();
  };
  // First open of each long thread is cold for the daemon's caches; the second is warm.
  await measure("openCold", longest.length, (index) => openThread(longest[index]?.id ?? ""));
  await measure("openWarm", longest.length, (index) => openThread(longest[index]?.id ?? ""));

  const target = longest[0]?.id ?? "";
  const pager = await fresh();
  const lease = pager.client.thread(target);
  await until(
    lease.store.select(
      ["thread", "order"],
      (store) => Boolean(store.thread) && store.order.length > 0,
    ),
    Boolean,
    "the paged thread",
  );
  await measure("loadOlder50", 30, () => pager.client.loadOlder(target, 50));
  // Deep history: turn pages walking back from the newest, then jumped windows across turns.
  const ordinals: number[] = [];
  let before: number | undefined;
  await measure("turnsPage100", 10, async () => {
    const page = await pager.client.turnsPage({
      threadId: target,
      limit: 100,
      ...(before === undefined ? {} : { before }),
    });
    for (const turn of page.turns) ordinals.push(turn.ordinal);
    before = page.before ?? undefined;
  });
  const spread = [...new Set(ordinals)].toSorted((a, b) => a - b);
  await measure("itemsWindow199", 20, async (index) => {
    const turnOrdinal = spread[Math.floor((index * spread.length) / 20)] ?? 1;
    await pager.client.itemsWindow({ threadId: target, turnOrdinal, before: 99, after: 99 });
  });
  lease.release();
  const words = ["daemon", "sqlite", "README", "error", "sidebar", "commit", "test"];
  await measure("threadSearchTree", words.length, async (index) => {
    await pager.client.threadSearch({ threadId: target, text: words[index] ?? "x", scope: "tree" });
  });
  await measure("globalSearch", words.length, async (index) => {
    await pager.client.request({
      type: "search.query",
      requestId: randomUUID(),
      text: words[index] ?? "x",
      mode: "tokens",
      scope: "items",
      filters: {},
      limit: 30,
    });
  });
  await pager.close();
  results["children"] = [...children];
  results["end"] = { ...(await probe.collected()), footprint: await footprint(running.pid) };
  await writeFile(join(out, `reads-${mode}.json`), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${join(out, `reads-${mode}.json`)}\n`);
} finally {
  inspector?.close();
  await daemon?.stop();
  unwatchLast();
}
