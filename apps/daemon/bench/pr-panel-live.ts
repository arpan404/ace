// Times what the pull request panel asks the daemon for when it opens a PR, and counts the
// GitHub requests behind each read. Reads only: it never sends a mutation.
//
//   node apps/daemon/bench/pr-panel-live.ts --workspace=<id> --number=1192 [--runs=3]
//   node apps/daemon/bench/pr-panel-live.ts --forge --cwd=<checkout> --number=1192
//
// Without --forge it connects to the running daemon (~/.ace/daemon-endpoint and
// daemon-token) and replays the panel's reads: first paint, the Summary tab's reads, then the
// Timeline and Code tabs. With --forge it runs the same reads straight through @ace/forge with
// the person's own `gh`, logging every GitHub request: how many, and how many in a row.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Client, webSocketTransport } from "@ace/client";
import {
  GitHubForge,
  createCommandRunner,
  type CommandRequest,
  type CommandRunner,
} from "@ace/forge";
import {
  DeviceId,
  WorkspaceActionRequest,
  type ForgeBrowserOperation,
  type ForgeBrowserResult,
  type ForgePrDetail,
  type ForgeRepository,
} from "@ace/protocol";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value] as const;
  }),
);
const number = Number(args.get("number") ?? 1192);
const runs = Number(args.get("runs") ?? 3);
const ms = (start: number) => Math.round(performance.now() - start);

const strip = (entry: { label: string; ms: number; error?: string; pages?: number }) => ({
  label: entry.label,
  ms: entry.ms,
  ...(entry.error ? { error: entry.error.slice(0, 200) } : {}),
  ...(entry.pages ? { pages: entry.pages } : {}),
});

type Call = { label: string; start: number; end: number };
/** Longest chain of requests where each starts after the previous one ended. */
function serialDepth(calls: readonly Call[]): number {
  const sorted = calls.toSorted((a, b) => a.end - b.end);
  const depth = new Map<Call, number>();
  for (const call of sorted) {
    let best = 0;
    for (const before of sorted)
      if (before.end <= call.start) best = Math.max(best, depth.get(before) ?? 0);
    depth.set(call, best + 1);
  }
  return Math.max(0, ...depth.values());
}

async function daemonRun() {
  const workspaceId = args.get("workspace");
  if (!workspaceId) throw new Error("--workspace=<id> is required");
  const root = join(homedir(), ".ace");
  const endpoint = (await readFile(join(root, "daemon-endpoint"), "utf8")).trim();
  const token = (await readFile(join(root, "daemon-token"), "utf8")).trim();
  let saved: string | null = null;
  const client = new Client({
    deviceId: DeviceId.parse("pr-panel-bench"),
    transport: () => webSocketTransport(() => new WebSocket(endpoint.replace(/^http/, "ws"))),
    storage: {
      load: async () => saved,
      save: async (value: string) => {
        saved = value;
      },
    },
    credential: async () => token,
    scheduler: {
      set(delay: number, run: () => void) {
        const timer = setTimeout(run, delay);
        return () => clearTimeout(timer);
      },
    },
    random: Math.random,
    id: () => crypto.randomUUID(),
  });
  await client.start();
  const connectBy = performance.now() + 15_000;
  while (client.state !== "ready") {
    if (performance.now() > connectBy) throw new Error(`daemon connection is ${client.state}`);
    await new Promise((done) => setTimeout(done, 20));
  }
  const read = async (operation: Record<string, unknown>): Promise<ForgeBrowserResult> => {
    const reply = await client.request(
      WorkspaceActionRequest.parse({
        type: "workspace.request",
        requestId: "bench",
        operation: { workspaceId, ...operation } as ForgeBrowserOperation,
      }),
      { signal: AbortSignal.timeout(60_000) },
    );
    if (reply.result.kind !== "forge") throw new Error(JSON.stringify(reply.result));
    return reply.result.data;
  };
  const timed = async (label: string, operation: Record<string, unknown>) => {
    const start = performance.now();
    try {
      const result = await read(operation);
      return { label, ms: ms(start), result };
    } catch (error) {
      return { label, ms: ms(start), error: String(error) };
    }
  };
  /** Every page of a paged read, one after another, as the panel's queries do. */
  const paged = async (label: string, operation: Record<string, unknown>, max: number) => {
    const start = performance.now();
    let page: number | undefined = 1;
    let pages = 0;
    while (page !== undefined && page <= max) {
      const result = await read({ ...operation, page });
      pages++;
      const next = "nextPage" in result ? result.nextPage : undefined;
      page = typeof next === "number" && next > page ? next : undefined;
    }
    return { label, ms: ms(start), pages };
  };
  for (let run = 1; run <= runs; run++) {
    const opened = performance.now();
    const detailRead = await timed("forge.pr.detail", { op: "forge.pr.detail", number });
    const detail =
      "result" in detailRead && detailRead.result?.resource === "prDetail"
        ? (detailRead.result.value as ForgePrDetail)
        : undefined;
    if (!detail) {
      console.log(JSON.stringify({ run, detailRead }));
      continue;
    }
    const repository: ForgeRepository = detail.status.ref.repository;
    const base = { repository, number };
    const summaryStart = performance.now();
    const summary = await Promise.all([
      timed("forge.pr.lifecycle", { op: "forge.pr.lifecycle", ...base }),
      timed("forge.pr.merge-state", { op: "forge.pr.merge-state", ...base }),
      timed("forge.pr.review-state", { op: "forge.pr.review-state", ...base }),
      timed("forge.pr.stack", { op: "forge.pr.stack", ...base }),
      timed("forge.pr.stack-memberships", {
        op: "forge.pr.stack-memberships",
        repository,
        numbers: [number],
      }),
      timed("forge.pr.files p1", {
        op: "forge.pr.files",
        ...base,
        page: 1,
        headSha: detail.status.headSha,
        baseSha: detail.baseSha,
      }),
      ...(detail.status.state === "merged" || detail.status.state === "closed"
        ? [paged("forge.pr.activity (all pages)", { op: "forge.pr.activity", ...base }, 120)]
        : []),
    ]);
    const summaryMs = ms(summaryStart);
    const timelineStart = performance.now();
    const timeline = await Promise.all([
      paged(
        "forge.pr.commits (all pages)",
        { op: "forge.pr.commits", ...base, headSha: detail.status.headSha },
        10,
      ),
      paged("forge.pr.activity (all pages)", { op: "forge.pr.activity", ...base }, 120),
    ]);
    const timelineMs = ms(timelineStart);
    const codeStart = performance.now();
    // The Code tab's first page, read again as the panel did before its reads were kept.
    const code = [
      await timed("forge.pr.files p1", {
        op: "forge.pr.files",
        ...base,
        page: 1,
        headSha: detail.status.headSha,
        baseSha: detail.baseSha,
      }),
    ];
    const codeMs = ms(codeStart);
    console.log(
      JSON.stringify(
        {
          run,
          firstPaintMs: detailRead.ms,
          summaryReadsMs: summaryMs,
          summaryCompleteMs: detailRead.ms + summaryMs,
          summary: summary.map(strip),
          timelineTabMs: timelineMs,
          timeline: timeline.map(strip),
          codeTabMs: codeMs,
          code: code.map(strip),
          totalMs: ms(opened),
        },
        null,
        2,
      ),
    );
  }
  await client.close();
}

async function forgeRun() {
  const cwd = args.get("cwd") ?? process.cwd();
  const owner = args.get("owner") ?? "arpan404";
  const name = args.get("name") ?? "ace";
  const base = createCommandRunner({ cwd });
  let calls: Call[] = [];
  const runner: CommandRunner = async (request: CommandRequest) => {
    if (request.args.includes("--method") && !request.args.includes("GET")) {
      // GraphQL reads are POSTs; anything else is a write and never runs here.
      if (request.args[1] !== "graphql") throw new Error("bench refuses writes");
    }
    const start = performance.now();
    try {
      return await base(request);
    } finally {
      calls.push({ label: String(request.args[1]).slice(0, 80), start, end: performance.now() });
    }
  };
  const forge = new GitHubForge({
    repository: { forge: "github", host: "github.com", owner, name },
    runner,
    now: Date.now,
  });
  const signal = AbortSignal.timeout(120_000);
  const measure = async (label: string, read: () => Promise<unknown>) => {
    calls = [];
    const start = performance.now();
    await read();
    const elapsed = ms(start);
    console.log(
      JSON.stringify({
        label,
        ms: elapsed,
        requests: calls.length,
        serial: serialDepth(calls),
        paths: calls.map((call) => call.label),
      }),
    );
  };
  for (let run = 1; run <= runs; run++) {
    console.log(`# run ${run}`);
    let detail: ForgePrDetail | undefined;
    await measure("prDetail", async () => {
      detail = await forge.prDetail(number, signal);
    });
    if (!detail) return;
    const known = detail;
    await measure("lifecycle.snapshot", () => forge.lifecycle.snapshot(number, signal));
    await measure("prMergeState", () => forge.prMergeState(number, signal));
    await measure("reviews.host+viewed", () =>
      Promise.all([forge.reviews.host(number, signal), forge.reviews.viewedNow(number, signal)]),
    );
    await measure("prStack", () => forge.prStack(number, signal));
    await measure("stackMemberships", () => forge.stackMemberships([number], signal));
    await measure("prFiles p1", () =>
      forge.prFiles(
        { number, page: 1, headSha: known.status.headSha, baseSha: known.baseSha },
        signal,
      ),
    );
    await measure("prCommits (all pages)", async () => {
      let page: number | undefined = 1;
      while (page !== undefined) {
        const result = await forge.prCommits(number, page, known.status.headSha, signal);
        page = result.nextPage;
      }
    });
    await measure("prActivity (all pages)", async () => {
      let page: number | undefined = 1;
      while (page !== undefined) {
        const result = await forge.prActivity(number, page, signal);
        page = result.nextPage;
      }
    });
  }
}

await (args.has("forge") ? forgeRun() : daemonRun());
