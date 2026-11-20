import { facts } from "@ace/fake-daemon";
import { HostId, ThreadId } from "@ace/protocol";
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

test("the machines list keeps offline and not-allowed machines with the reason, and an offline one can't be chosen", async () => {
  const app = await mac();
  expect(app.machines()?.machines).toEqual([
    { hostId: "build", name: "Build server", deviceId: "fleet-this-mac-on-build", reason: null },
    { hostId: "studio", name: "Studio", deviceId: "fleet-this-mac-on-studio", reason: "Offline" },
    {
      hostId: "laptop",
      name: "Old laptop",
      deviceId: "fleet-this-mac-on-laptop",
      reason: "Projects not allowed",
    },
  ]);
  app.act({ kind: "open", subject: forecast });
  await app.sheetAt("machines");
  app.act({ kind: "choose", hostId: "studio" });
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

test("Continue on is offered while the thread works, and not once its work moved", async () => {
  const app = await mac();
  app.openThread();
  await until(() => app.thread()?.canContinue === true, "settled");
  app.daemon.apply("thread-forecast", [facts.rootAgent("claude"), facts.turn("root")]);
  await until(() => app.thread()?.canContinue === true, "offered while working");
  expect(app.thread()?.blocked).toBeNull();
  app.daemon.apply("thread-forecast", [
    facts.endTurn("root"),
    {
      type: "thread.moved",
      to: { hostId: HostId.parse("studio"), name: "Studio", threadId: ThreadId.parse("there") },
    },
  ]);
  await until(() => app.thread()?.canContinue === false, "moved");
  expect(app.thread()?.blocked).toBe("Its work already moved to Studio");
  // Never done or idle: the thread says where its work went, with Open to follow it there.
  expect(said(app.thread()?.line)).toEqual({ words: "Moved to Studio", actions: ["Open"] });
  expect(app.strip()?.open).toEqual({ hostId: "studio", threadId: "there", workspaceId: null });
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

test("a working thread's move says where it stands, and a stop that failed says it stayed here", () => {
  const app = linkedMac();
  app.agentContinues();
  const [preparing] = app.daemon.transfers.list();
  if (!preparing) throw new Error("no transfer");
  const line = (more: Partial<typeof preparing>) =>
    said(transferLine({ ...preparing, ...more }, { retry: true }));
  expect(
    line({
      phase: "sending",
      sentBytes: 312_000_000,
      totalBytes: 1_200_000_000,
      live: { stage: "readying" },
    }),
  ).toEqual({ words: "Getting Build server ready · 312 MB of 1.2 GB", actions: ["Cancel"] });
  expect(line({ phase: "sending", live: { stage: "stopping" } })?.words).toBe(
    "Stopping the work here",
  );
  expect(line({ phase: "importing", live: { stage: "handing" } })?.words).toBe(
    "Moving to Build server",
  );
  expect(
    line({ phase: "failed", error: { code: "remote_child_unconfirmed", message: "" } }),
  ).toEqual({
    words: "A subagent on another machine never confirmed it stopped, so the thread stayed here.",
    actions: ["Try again"],
  });
  expect(line({ phase: "failed", error: { code: "target_too_old", message: "" } })?.words).toBe(
    "Build server runs an older ace that can't take a working thread. Let it finish here, or update ace there.",
  );
});

test("a transfer ace's relay won't carry says how to send it", async () => {
  const relay =
    "Only ace's relay reaches that machine right now, and it carries a project's files only up to 8 MiB. Send it again while the machines reach each other directly (LAN or Tailscale), or link them through your own relay.";
  const app = await mac();
  app.daemon.transfers.failWith = { code: "not_supported", message: relay };
  app.act({ kind: "open", subject: forecast });
  await app.sheetAt("machines");
  app.act({ kind: "choose", hostId: "build" });
  app.act({ kind: "send", includeChanges: true, includeIgnored: true });
  await app.finish();
  await app.sheetAt("status", (step) => said(step.line)?.words === relay);
});
