import { Client } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { CommandId, DeviceId, HostId, ThreadId } from "@ace/protocol";
import { RecordingSink, until } from "./sheet-fixture.ts";
import type { Line } from "./transfer-lines.ts";
import { NativeTransfers, TransferAction } from "./transfers.ts";

/*
 * Test support for the phone's transfers: this Mac's real SDK client on a fake daemon linked to
 * a build server (takes transfers), a studio that is offline and a laptop that doesn't allow
 * projects. Each transfer step runs when the test says so.
 */

export const workspace = { id: "weather", name: "weather", path: "/Users/dev/weather" };

type Shown = Record<string, unknown>;
const settledPhases = new Set(["completed", "failed", "cancelled"]);

export function linkedMac(options: { links?: boolean } = {}) {
  let now = 1_000;
  let ids = 0;
  const clock = () => (now += 1);
  const steps: (() => void)[] = [];
  const projectScheduler = (callback: () => void) => void steps.push(callback);
  const machine = (hostId: string, displayName: string) =>
    new FakeDaemon({ clock, hostId, displayName, projectScheduler });
  const build = machine("build", "Build server");
  const studio = machine("studio", "Studio");
  const laptop = machine("laptop", "Old laptop");
  const daemon = new FakeDaemon({
    clock,
    hostId: "this-mac",
    displayName: "MacBook",
    projectScheduler,
  });
  if (options.links !== false) {
    daemon.linkTo(build);
    daemon.linkTo(studio, { status: "offline" });
    daemon.linkTo(laptop, { projects: false });
  }
  daemon.createThread({
    id: "thread-forecast",
    workspaceId: workspace.id,
    title: "Fix the forecast cache",
    provider: "claude",
    hasSentMessage: true,
    details: { workspace },
  });
  const client = new Client({
    deviceId: DeviceId.parse("ios-transfer-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++ids}`,
  });
  const sink = new RecordingSink();
  const transfers = new NativeTransfers(client, sink);
  const settled = () =>
    [daemon, build].every((each) => each.transfers.list().every((t) => settledPhases.has(t.phase)));
  const app = {
    daemon,
    build,
    client,
    sink,
    transfers,
    /** Run the next queued transfer step, once one is queued. */
    async step() {
      await until(() => steps.length > 0, "a transfer step");
      steps.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    /** Once this Mac has `count` transfers, run every step until all have settled. */
    async finish(count = 1) {
      await until(() => daemon.transfers.list().length >= count, `${count} transfers`);
      while (!settled()) await app.step();
    },
    act(action: TransferAction) {
      transfers.handle(TransferAction.parse(action));
    },
    machines: () => sink.read("transfers:machines"),
    sheet: () => sink.read("transfers:sheet")?.sheet as Shown | null | undefined,
    step$: () => (app.sheet()?.step as Shown | undefined) ?? undefined,
    thread: () => sink.read("transfers:thread")?.thread as Shown | null | undefined,
    /** The open thread's line above its composer. */
    strip: () => app.thread()?.line as Line | null | undefined,
    /** Wait until the sheet's step reads `kind` and passes `check`. */
    async sheetAt(kind: string, check: (step: Shown) => boolean = () => true) {
      await until(() => {
        const step = app.step$();
        return step?.kind === kind && check(step);
      }, `the sheet's ${kind} step`);
      return app.step$() as Shown;
    },
    async start() {
      await client.start();
      await until(() => client.state === "ready", "ready");
      await until(() => app.machines()?.state === "ready", "the machines");
      return app;
    },
    /** Open the thread's page, as the phone does, so its line follows it. */
    openThread() {
      const lease = client.thread("thread-forecast");
      transfers.follow({ threadId: "thread-forecast", epoch: 1, store: lease.store });
      return lease;
    },
    /** An agent on this Mac continues the thread on the build server. */
    agentContinues() {
      return daemon.transfers.start({
        id: CommandId.parse(`agent-transfer-${++ids}`),
        deviceId: DeviceId.parse("agent-device"),
        payload: {
          type: "thread.continueOn",
          threadId: ThreadId.parse("thread-forecast"),
          hostId: HostId.parse("build"),
          includeChanges: true,
        },
      });
    },
    close: () => {
      transfers.dispose();
      return client.close();
    },
  };
  return app;
}

/** The line's words and its buttons, as the phone reads them. */
export function said(line: unknown): { words: string; actions: string[] } | undefined {
  if (typeof line !== "object" || line === null || !("words" in line)) return undefined;
  const { words, actions } = line as { words: string; actions: { label: string }[] };
  return { words, actions: actions.map((each) => each.label) };
}

export const forecast = {
  kind: "thread",
  threadId: "thread-forecast",
  title: "Fix the forecast cache",
} as const;
