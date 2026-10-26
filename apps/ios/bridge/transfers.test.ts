import { facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { until } from "./sheet-fixture.ts";
import { forecast, linkedMac, said, workspace } from "./transfer-fixture.ts";
import { transferLine } from "./transfer-lines.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function mac(options: { links?: boolean } = {}) {
  const app = linkedMac(options);
  close = app.close;
  return app.start();
}

test("the machines list keeps offline and not-allowed machines with the reason, and none of them can be chosen", async () => {
  const app = await mac();
  expect(app.machines()?.machines).toEqual([
    { hostId: "build", name: "Build server", reason: null },
    { hostId: "studio", name: "Studio", reason: "Offline" },
    { hostId: "laptop", name: "Old laptop", reason: "Projects not allowed" },
  ]);
  app.act({ kind: "open", subject: forecast });
  await app.sheetAt("machines");
  app.act({ kind: "choose", hostId: "studio" });
  app.act({ kind: "choose", hostId: "laptop" });
  expect(app.step$()?.kind).toBe("machines");
  app.act({ kind: "choose", hostId: "build" });
  expect(await app.sheetAt("options")).toMatchObject({
    action: "Continue on Build server",
    ignoredByDefault: true,
  });
});

test("a machine with no fleet links offers no machine at all", async () => {
  const app = await mac({ links: false });
  expect(app.machines()?.machines).toEqual([]);
});

test("Continue on carries the thread there: sending with Cancel, then done with Open on both threads", async () => {
  const app = await mac();
  app.openThread();
  await until(() => app.thread()?.canContinue === true, "the thread can continue");
  expect(app.thread()?.line).toBeNull();

  app.act({ kind: "open", subject: forecast });
  await app.sheetAt("machines");
  app.act({ kind: "choose", hostId: "build" });
  await app.sheetAt("options");
  app.act({ kind: "send", includeChanges: true, includeIgnored: false });
  await app.sheetAt("status", (step) => (step.line as { transferId: unknown }).transferId !== null);
  expect(said(app.step$()?.line)?.words).toBe("Getting ready to send to Build server");
  expect(said(app.step$()?.line)?.actions).toEqual(["Cancel"]);

  await app.step();
  await app.step();
  await app.sheetAt(
    "status",
    (step) => said(step.line)?.words.startsWith("Sending to Build server ·") === true,
  );
  // The same line shows above the thread's composer, whoever is looking.
  await until(
    () => said(app.thread()?.line)?.words.startsWith("Sending to Build server") === true,
    "strip",
  );
  expect(said(app.thread()?.line)?.actions).toEqual(["Cancel"]);

  await app.finish();
  const done = await app.sheetAt(
    "status",
    (step) => said(step.line)?.words === "Continued on Build server",
  );
  expect((done.line as { open: unknown }).open).toMatchObject({ hostId: "build" });
  await until(() => said(app.thread()?.line)?.words === "Continued on Build server", "continued");
  const landed = app.strip()?.open?.threadId;
  if (!landed) throw new Error("no thread there");
  expect(app.build.snapshot({ kind: "thread", threadId: ThreadId.parse(landed) })).toBeDefined();
  expect(app.daemon.transfers.list()[0]?.options).toEqual({
    includeChanges: true,
    includeIgnored: false,
  });
});

test("Continue on can't be offered while the thread is working, and comes back once it stops", async () => {
  const app = await mac();
  app.openThread();
  await until(() => app.thread()?.canContinue === true, "settled");
  app.daemon.apply("thread-forecast", [facts.rootAgent("claude"), facts.turn("root")]);
  await until(() => app.thread()?.canContinue === false, "working");
  app.daemon.apply("thread-forecast", [facts.endTurn("root")]);
  await until(() => app.thread()?.canContinue === true, "done");
});

test("Cancel stops the transfer, and the line says so with Try again", async () => {
  const app = await mac();
  app.act({ kind: "open", subject: forecast });
  await app.sheetAt("machines");
  app.act({ kind: "choose", hostId: "build" });
  app.act({ kind: "send", includeChanges: true, includeIgnored: true });
  await app.step();
  const running = await app.sheetAt(
    "status",
    (step) => said(step.line)?.actions.includes("Cancel") === true,
  );
  const transferId = String((running.line as { transferId: string }).transferId);
  app.act({ kind: "line", transferId, act: "cancel" });
  await app.sheetAt(
    "status",
    (step) => said(step.line)?.words === "Cancelled sending to Build server",
  );
  expect(said(app.step$()?.line)?.actions).toEqual(["Try again"]);
});

test("a failure shows the daemon's words, and Try again repeats the same choices", async () => {
  const app = await mac();
  app.daemon.transfers.failWith = {
    code: "changes_conflict",
    message: "The changes don't apply on Build server.",
  };
  app.act({ kind: "open", subject: forecast });
  await app.sheetAt("machines");
  app.act({ kind: "choose", hostId: "build" });
  app.act({ kind: "send", includeChanges: false, includeIgnored: true, parent: "/fake/work" });
  await app.finish();
  const failed = await app.sheetAt(
    "status",
    (step) => said(step.line)?.words === "The changes don't apply on Build server.",
  );
  expect((failed.line as { alert: boolean }).alert).toBe(true);

  app.daemon.transfers.failWith = undefined;
  app.act({ kind: "retry" });
  await app.finish(2);
  await app.sheetAt("status", (step) => said(step.line)?.words === "Continued on Build server");
  const [again] = app.daemon.transfers.list();
  expect(again?.options).toEqual({
    includeChanges: false,
    includeIgnored: true,
    parent: "/fake/work",
  });
});

test("Try again on the thread's line without echoed choices opens the options for that machine", async () => {
  const app = await mac();
  app.daemon.transfers.echoOptions = false;
  app.daemon.transfers.failWith = { code: "clone_failed", message: "" };
  app.openThread();
  app.agentContinues();
  await app.finish();
  await until(
    () =>
      said(app.thread()?.line)?.words === "Build server couldn't set the project up. Try again.",
    "failed",
  );
  expect(said(app.thread()?.line)?.actions).toEqual(["Try again", "Dismiss"]);
  const transferId = String(app.strip()?.transferId);
  app.act({ kind: "line", transferId, act: "retry" });
  expect(await app.sheetAt("options")).toMatchObject({
    machine: { hostId: "build", name: "Build server" },
  });

  app.act({ kind: "close" });
  app.act({ kind: "line", transferId, act: "dismiss" });
  await until(() => app.thread()?.line === null, "dismissed");
});

test("a refused start says why, from the daemon's code when it gave no words", async () => {
  const app = await mac();
  app.act({ kind: "open", subject: { kind: "project", workspaceId: "nowhere", name: "nowhere" } });
  await app.sheetAt("machines");
  app.act({ kind: "choose", hostId: "build" });
  app.act({ kind: "send", includeChanges: true, includeIgnored: true });
  const refused = await app.sheetAt("status", (step) => (step.line as { alert: boolean }).alert);
  expect(said(refused.line)).toEqual({
    words: "That project isn't on this machine.",
    actions: ["Try again"],
  });
});

test("Open on carries a project without a thread and its line opens the project there", async () => {
  const app = await mac();
  app.act({
    kind: "open",
    subject: { kind: "project", workspaceId: workspace.id, name: workspace.name },
  });
  await app.sheetAt("machines");
  app.act({ kind: "choose", hostId: "build" });
  expect((await app.sheetAt("options")).action).toBe("Open on Build server");
  app.act({ kind: "send", includeChanges: true, includeIgnored: true });
  await app.finish();
  const done = await app.sheetAt(
    "status",
    (step) => said(step.line)?.words === "Opened on Build server",
  );
  expect((done.line as { open: { threadId: unknown } }).open.threadId).toBeNull();
});

test("a transfer starting its thread there can no longer be cancelled", () => {
  const app = linkedMac();
  const transfer = app.agentContinues();
  expect(transfer.ok).toBe(true);
  const [preparing] = app.daemon.transfers.list();
  if (!preparing) throw new Error("no transfer");
  expect(transferLine(preparing, { retry: true }).actions.map((each) => each.act)).toEqual([
    "cancel",
  ]);
  const starting = { ...preparing, phase: "starting" as const };
  expect(transferLine(starting, { retry: true })).toMatchObject({
    words: "Starting the thread on Build server",
    actions: [],
  });
});
