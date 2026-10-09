import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, readdir, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer, preview } from "vite";
import { chromium, expect, type BrowserContext } from "@playwright/test";
import { z } from "zod";
import { checkLog, checkRss, type Finding } from "./checks.ts";
import { startReal, rssMiB } from "./processes.ts";
import { guardProxy } from "./proxy.ts";
import { probe } from "./probe.ts";
import { fixtureSetup } from "./fixture.ts";
import { scrubber, writeReport, type Report } from "./report.ts";
import { prepareOutput } from "./paths.ts";
import { runTour } from "./tour.ts";

export interface SmokeOptions {
  fixture: boolean;
  out: string;
  homeSource: string;
  maxThreads: number;
  scanTimeoutMs: number;
  stepTimeoutMs: number;
  executablePath?: string;
}
const Log = z.object({
  level: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
});
export async function readLogs(home: string): Promise<Finding[]> {
  const failures: Finding[] = [];
  for (const name of await readdir(join(home, "logs"))) {
    if (!/^ace\.\d+\.jsonl$/.test(name)) continue;
    const lines = createInterface({
      input: createReadStream(join(home, "logs", name)),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      const entry = Log.parse(JSON.parse(line));
      const data = z.record(z.string(), z.unknown()).safeParse(entry.data);
      failures.push(...checkLog({ ...entry, ...(data.success ? { fields: data.data } : {}) }));
    }
  }
  return failures;
}
export async function runSmoke(options: SmokeOptions): Promise<Report> {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const out = await prepareOutput(options.out, options.homeSource);
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "ace-real-smoke-")));
  const home = join(scratch, "home");
  await mkdir(home, { recursive: true });
  await mkdir(join(scratch, "projects"));
  const report: Report = {
    mode: options.fixture ? "fixture" : "real",
    sha,
    failures: [],
    steps: [],
    timings: {},
    copied: [],
    threadsVisited: 0,
    completed: false,
  };
  let scrub = scrubber();
  const failure = (finding: Finding) => {
    const last = report.activeStep ?? report.steps.at(-1);
    report.failures.push({
      ...finding,
      message: scrub(finding.message),
      step: last?.name ?? "startup",
      screenshot: last?.screenshot ?? "",
    });
  };
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(new Error("Smoke interrupted"));
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const cleanups: (() => void | Promise<void>)[] = [];
  let real:
    | { proxyUrl: string; token: string; inspector: Awaited<ReturnType<typeof probe>> }
    | undefined;
  let daemon: Awaited<ReturnType<typeof startReal>> | undefined;
  try {
    const web = new URL("../../../apps/web/", import.meta.url).pathname;
    let origin: string;
    if (options.fixture) {
      const server = await createServer({
        root: web,
        mode: "fake",
        logLevel: "silent",
        server: { host: "127.0.0.1", port: 0 },
      });
      await server.listen();
      cleanups.push(() => server.close());
      const address = server.httpServer?.address();
      if (!address || typeof address === "string")
        throw new Error("Fixture server has no listener");
      origin = `http://127.0.0.1:${address.port}`;
    } else {
      // Copy under filesystem protection too: SQLite cannot create WAL sidecars in source.
      const copied = execFileSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(scratch)}) (literal "/dev/null"))`,
          process.execPath,
          new URL("./copy-child.ts", import.meta.url).pathname,
          options.homeSource,
          home,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      report.copied = z.array(z.string()).parse(JSON.parse(copied));
      const began = performance.now();
      daemon = await startReal(scratch, options.homeSource, failure);
      report.timings.daemonStart = performance.now() - began;
      cleanups.push(() => daemon?.stop());
      scrub = scrubber(daemon.token);
      const proxy = await guardProxy(daemon.url, failure);
      cleanups.push(proxy.close);
      const inspector = await probe(proxy.url, daemon.token);
      cleanups.push(() => inspector.close());
      await build({
        root: web,
        logLevel: "silent",
        build: { outDir: join(scratch, "web"), emptyOutDir: true },
      });
      const server = await preview({
        root: web,
        logLevel: "silent",
        build: { outDir: join(scratch, "web") },
        preview: { host: "127.0.0.1", port: 0, strictPort: true },
      });
      cleanups.push(() => server.close());
      const address = server.httpServer.address();
      if (!address || typeof address === "string") throw new Error("Preview has no listener");
      origin = `http://127.0.0.1:${address.port}`;
      proxy.allowOrigin(origin);
      real = { proxyUrl: proxy.url, token: daemon.token, inspector };
    }
    const browser = await chromium.launch({
      executablePath: options.executablePath ?? chromium.executablePath(),
    });
    cleanups.push(() => browser.close());
    const contexts: BrowserContext[] = [];
    const coldPage = async () => {
      for (const context of contexts.splice(0)) await context.close();
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
        reducedMotion: "reduce",
        serviceWorkers: "block",
      });
      contexts.push(context);
      await context.addInitScript(
        ({ url, token }) => {
          localStorage.setItem("ace.appearance", JSON.stringify({ theme: "dark" }));
          localStorage.setItem("ace.profile.name", "Smoke");
          if (url) localStorage.setItem("ace.daemon.url", url);
          if (token) sessionStorage.setItem("ace.daemon.token", token);
        },
        { url: real?.proxyUrl ?? "", token: real?.token ?? "" },
      );
      if (options.fixture) await context.addInitScript(fixtureSetup);
      await context.route("**/*", (route) => {
        const request = route.request();
        const url = new URL(request.url());
        // Browser navigation is local only, with no credential-bearing network or mutations.
        if (
          real &&
          url.origin === real.proxyUrl.replace(/^ws:/, "http:").replace(/\/$/, "") &&
          ["GET", "OPTIONS"].includes(request.method()) &&
          ["/v1/status", "/v1/devices"].includes(url.pathname)
        )
          return route.continue();
        if (url.origin === origin && ["GET", "HEAD"].includes(request.method()))
          return route.continue();
        return route.abort();
      });
      return context.newPage();
    };
    const page = await coldPage();
    const catalogs = async () => {
      if (!real) return;
      const result = await real.inspector.request({ type: "models.refresh", filter: {} });
      if (result.type !== "models.result" || !("models" in result.result))
        throw new Error("Model catalog did not report ready");
      if (result.result.instances.some((instance) => instance.refreshing))
        throw new Error("Model catalog still refreshing");
      const providers = await real.inspector.request({
        type: "providers.request",
        operation: "refresh",
      });
      if (providers.type !== "providers.result" || !providers.result.ok)
        throw new Error("Providers did not report ready");
      await expect
        .poll(
          async () => {
            const reply = await real?.inspector.request({
              type: "providers.request",
              operation: "list",
            });
            return (
              reply?.type === "providers.result" &&
              reply.result.ok &&
              reply.result.providers.every((provider) => !provider.refreshing)
            );
          },
          { timeout: options.stepTimeoutMs },
        )
        .toBe(true);
    };
    const scan = async () => {
      if (!real) return;
      const began = performance.now();
      await real.inspector.request({ type: "history.scan", action: "start" });
      await expect
        .poll(
          async () => {
            const reply = await real?.inspector.request(
              { type: "history.scan", action: "status" },
              options.stepTimeoutMs,
            );
            if (reply?.type !== "history.scan" || reply.scan?.state === "failed")
              throw new Error("Past sessions scan failed");
            return reply.scan?.state;
          },
          { timeout: options.scanTimeoutMs },
        )
        .toBe("ready");
      report.timings.scan = performance.now() - began;
    };
    const pastSessionsPath = async () => {
      if (!real) return "/new?project=relay";
      const reply = await real.inspector.request({
        type: "workspace.request",
        operation: { op: "workspaces.list", limit: 100 },
      });
      if (reply.type !== "workspace.result" || reply.result.kind !== "workspaces")
        throw new Error("Workspace list unavailable");
      for (const workspace of reply.result.workspaces) {
        const sessions = await real.inspector.request({
          type: "history.list",
          cwd: workspace.path,
          openableOnly: true,
          limit: 4,
        });
        if (
          sessions.type === "history.list" &&
          sessions.sessions.some((session) => session.support.status === "supported")
        )
          return `/new?project=${encodeURIComponent(workspace.id)}`;
      }
      throw new Error("No importable past session in the first 100 stored workspaces");
    };
    await runTour({
      signal: lifetime.signal,
      page,
      origin,
      out,
      report,
      maxThreads: options.maxThreads,
      stepTimeoutMs: options.stepTimeoutMs,
      scanTimeoutMs: options.scanTimeoutMs,
      scrub,
      catalogs,
      scan,
      pastSessionsPath,
      coldPage,
    });
    if (daemon?.child.pid) {
      // The UI can start another scan; measure only after background catalogs settle.
      await expect
        .poll(
          async () => {
            const scanStatus = await real?.inspector.request({
              type: "history.scan",
              action: "status",
            });
            const models = await real?.inspector.request({ type: "models.list", filter: {} });
            const providers = await real?.inspector.request({
              type: "providers.request",
              operation: "list",
            });
            return (
              scanStatus?.type === "history.scan" &&
              scanStatus.scan?.state !== "scanning" &&
              models?.type === "models.result" &&
              "models" in models.result &&
              models.result.instances.every((instance) => !instance.refreshing) &&
              providers?.type === "providers.result" &&
              providers.result.ok &&
              providers.result.providers.every((provider) => !provider.refreshing)
            );
          },
          { timeout: options.scanTimeoutMs },
        )
        .toBe(true);
      report.daemonRssMiB = rssMiB(daemon.child.pid);
      for (const finding of checkRss(report.daemonRssMiB)) failure(finding);
    }
  } catch (error) {
    failure({
      code: "runner-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    for (const close of cleanups.toReversed())
      try {
        await close();
      } catch {
        failure({ code: "cleanup-failed", message: "A smoke-owned resource failed to close" });
      }
    if (daemon)
      try {
        for (const finding of await readLogs(home)) failure(finding);
      } catch {
        failure({ code: "daemon-logs", message: "Daemon logs could not be checked" });
      }
    await rm(scratch, { recursive: true, force: true });
  }
  await writeReport(out, report, scrub);
  return report;
}
export function defaultSource() {
  return join(homedir(), ".ace-next");
}
