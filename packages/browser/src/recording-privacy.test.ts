import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BrowserArtifact } from "@ace/protocol";
import { FakeMediaRecorder } from "@ace/media/testing/fake-recorder";
import { markedJpeg, type FakePage } from "./backend-test-support.ts";
import { TestNavigationClock } from "./navigation-test-clock.ts";
import { BrowserService } from "./service.ts";
import { TabbedHeadless } from "./tabbed-test-support.ts";

/*
 * What a browser recording takes, through the service, on fake tabs and a fake ace-media
 * recorder: each picture handed to ace-media is checked against the recorded tab's own
 * privacy at the time it was captured. Each test's pictures carry their own JPEG height, so
 * the recorder's units say which pictures got through.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const person = { kind: "human", connectionId: "person" } as const;

async function thread() {
  const home = await mkdtemp(join(tmpdir(), "ace-recording-privacy-"));
  const clock = { now: 1_000_000 };
  const recorder = new FakeMediaRecorder();
  const artifacts: BrowserArtifact[] = [];
  /** While set, publishing a recording's part waits for it. */
  const gate: { publishing: Promise<void> | undefined } = { publishing: undefined };
  const backend = new TabbedHeadless();
  const service = new BrowserService({
    dataDir: home,
    headlessBackend: backend,
    backendPreference: () => "headless",
    wakeWatch: false,
    navigationClock: new TestNavigationClock(),
    now: () => clock.now,
    recorder,
    onArtifact: async (_, artifact) => {
      artifacts.push(artifact);
      await gate.publishing;
    },
  });
  cleanups.push(async () => {
    await service.close();
    await rm(home, { recursive: true, force: true });
  });
  await service.open({ threadId: "thread", workspaceId: "workspace" });
  /** The page of the `index`th tab opened. */
  const page = (index: number): FakePage => {
    const found = backend.pages[index];
    if (!found) throw new Error(`no page ${index}`);
    return found;
  };
  /** One screencast picture of a page, captured now. */
  const frame = (index: number, mark: number) => {
    clock.now += 100;
    page(index).events.emit("Page.screencastFrame", {
      sessionId: 1,
      data: markedJpeg(mark).toString("base64"),
      metadata: { deviceWidth: 16, deviceHeight: mark, timestamp: clock.now / 1000 },
    });
  };
  const recorded = () => recorder.last()?.units.map((unit) => unit.height) ?? [];
  return { service, backend, clock, recorder, page, frame, recorded, artifacts, gate };
}

it("records the public tab it follows, through ace-media's picture encode", async () => {
  const t = await thread();
  await t.service.startRecording("thread");
  expect(t.recorder.last()?.spec.origin).toEqual({ kind: "tab-pictures" });
  t.frame(0, 3);
  t.frame(0, 4);
  expect(t.recorded()).toEqual([3, 4]);
  const artifact = await t.service.stopRecording("thread");
  expect(artifact).toMatchObject({ mimeType: "video/mp4", path: expect.stringMatching(/\.mp4$/) });
  expect(artifact.bytes).toBeGreaterThan(0);
});

it("never records the old tab's pictures after the person moves from a private tab to a public one", async () => {
  const t = await thread();
  await t.service.execute("thread", { action: "tabs", operation: "open" });
  await t.service.execute(
    "thread",
    { action: "tabs", operation: "select", tabId: "tab-1" },
    person,
  );
  await t.service.startRecording("thread");
  t.frame(0, 3);
  expect(t.recorded()).toEqual([3]);
  t.clock.now += 1_000;
  t.service.setPrivate("thread", "tab-1", true);
  // As the view moves to the public tab, the private tab's capture is still attached while the
  // move settles: its pictures arrive carrying its own id.
  const request = t.backend.opens[0];
  if (!request) throw new Error("no open");
  const changed = request.changed;
  request.changed = () => {
    changed?.();
    t.frame(0, 5);
  };
  await t.service.execute(
    "thread",
    { action: "tabs", operation: "select", tabId: "tab-2" },
    person,
  );
  if (changed) request.changed = changed;
  t.frame(0, 6);
  expect(t.recorded()).toEqual([3]);
});

it("records nothing captured within the read gap after the tab stopped being private", async () => {
  const t = await thread();
  t.backend.screenshots = () => markedJpeg(1);
  t.page(0).command = (
    (command) => (method: string, params?: Record<string, unknown>) =>
      method === "Page.captureScreenshot"
        ? { data: markedJpeg(2).toString("base64") }
        : command(method, params)
  )(t.page(0).command.bind(t.page(0)));
  let seeds = 0;
  t.page(0).onSend = (method) => void (method === "Page.captureScreenshot" && seeds++);
  t.service.setPrivate("thread", "tab-1", true);
  t.clock.now += 1_000;
  t.service.setPrivate("thread", "tab-1", false);
  // 20 ms later: the page may still show what it hid. The recording's first screenshot and the
  // live capture's first picture are both from this moment.
  t.clock.now += 20;
  await t.service.startRecording("thread");
  await expect.poll(() => seeds).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(t.recorded()).toEqual([]);
  // Past the gap, the tab's pictures are recorded.
  t.clock.now += 100;
  t.frame(0, 7);
  expect(t.recorded()).toEqual([7]);
});

it("refuses to record, saying why, while ace-media can't record", async () => {
  const t = await thread();
  t.recorder.refuse = "ace-media isn't available to record: it keeps failing";
  await expect(t.service.startRecording("thread")).rejects.toMatchObject({
    code: "recording_failed",
    detail: "ace-media isn't available to record: it keeps failing",
  });
  expect(t.service.state("thread").recording).toBeUndefined();
});

it("a quick move to a private tab and back never records the private tab's pictures as the public one's", async () => {
  const t = await thread();
  await t.service.execute("thread", { action: "tabs", operation: "open" });
  // B (tab-2, public) is viewed and recorded; A (tab-1) is private.
  await t.service.startRecording("thread");
  t.frame(1, 3);
  expect(t.recorded()).toEqual([3]);
  t.clock.now += 1_000;
  t.service.setPrivate("thread", "tab-1", true);
  t.clock.now += 1_000;
  // A's own screenshot, should anything take one, is marked 9.
  const a = t.page(0);
  a.command = (
    (command) => (method: string, params?: Record<string, unknown>) =>
      method === "Page.captureScreenshot"
        ? { data: markedJpeg(9).toString("base64") }
        : command(method, params)
  )(a.command.bind(a));
  // B's screencast stop hangs while the capture moves to A.
  const b = t.page(1);
  const stopping = Promise.withResolvers<void>();
  const held = Promise.withResolvers<unknown>();
  b.command = ((command) => (method: string, params?: Record<string, unknown>) => {
    if (method !== "Page.stopScreencast") return command(method, params);
    stopping.resolve();
    return held.promise;
  })(b.command.bind(b));
  void t.service.execute("thread", { action: "tabs", operation: "select", tabId: "tab-1" }, person);
  await stopping.promise;
  // Back to B before the move to A got its screencast stopped.
  void t.service.execute("thread", { action: "tabs", operation: "select", tabId: "tab-2" }, person);
  await new Promise((resolve) => setTimeout(resolve, 10));
  held.resolve({});
  await new Promise((resolve) => setTimeout(resolve, 50));
  // A's live picture, whatever its capture thinks it shows.
  t.frame(0, 8);
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.frame(1, 4);
  expect(t.recorded()).not.toContain(9);
  expect(t.recorded()).not.toContain(8);
});

it("two recordings started at once on different tabs: one runs, the other is refused, nothing is orphaned", async () => {
  const t = await thread();
  await t.service.execute("thread", { action: "tabs", operation: "open" });
  const results = await Promise.allSettled([
    t.service.execute("thread", { action: "record_start", tabId: "tab-1" }),
    t.service.execute("thread", { action: "record_start", tabId: "tab-2" }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "recording_active" },
  });
  // Only one recording ever reached ace-media, and stopping it stops it.
  expect(t.recorder.recordings).toHaveLength(1);
  t.frame(results[0]?.status === "fulfilled" ? 0 : 1, 3);
  await t.service.stopRecording("thread").catch(() => {});
  expect(t.recorder.recordings.every((recording) => recording.stopped)).toBe(true);
});

it("a recording ace-media ends on its own stops showing as active, and its stop saves what was written and says it failed", async () => {
  const t = await thread();
  await t.service.startRecording("thread");
  t.frame(0, 3);
  t.recorder.last()?.fail("ingest-closed");
  // Its capture is gone: the browser no longer says it records, and says why.
  expect(t.service.state("thread").recording).toBeUndefined();
  expect(t.service.state("thread").recordingNotice).toMatch(/couldn't be written/);
  await expect(t.service.stopRecording("thread")).rejects.toMatchObject({
    code: "recording_failed",
    detail: "ingest-closed",
  });
  expect(t.artifacts).toEqual([expect.objectContaining({ mimeType: "video/mp4" })]);
  expect(t.service.state("thread").recordingNotice).toMatch(/saved to this thread/);
  // A new recording starts afresh.
  await t.service.startRecording("thread");
  expect(t.service.state("thread").recordingNotice).toBeUndefined();
});

it("a stop whose last moment ace-media couldn't confirm returns the recording and says its end may be incomplete", async () => {
  const t = await thread();
  t.recorder.truncate = true;
  await t.service.startRecording("thread");
  t.frame(0, 3);
  const artifact = await t.service.stopRecording("thread");
  expect(artifact.mimeType).toBe("video/mp4");
  expect(t.service.state("thread").recordingNotice).toMatch(/end may be incomplete/);
});

it("an earlier recording's stop finishing late never writes its notice over the next recording's", async () => {
  const t = await thread();
  await t.service.execute("thread", { action: "tabs", operation: "open" });
  t.recorder.truncate = true;
  // The recorded tab isn't the viewed one: its own screenshots are its pictures.
  t.backend.screenshots = () => markedJpeg(1);
  await t.service.execute("thread", { action: "record_start", tabId: "tab-1" });
  // Its stop frees the slot, then waits on publishing its part.
  const published = Promise.withResolvers<void>();
  t.gate.publishing = published.promise;
  const stopping = t.service.execute("thread", { action: "record_stop", tabId: "tab-1" });
  await expect.poll(() => t.artifacts.length).toBe(1);
  // Meanwhile a new recording starts on the other tab.
  t.gate.publishing = undefined;
  t.recorder.truncate = false;
  await t.service.execute("thread", { action: "record_start", tabId: "tab-2" });
  expect(t.service.state("thread").recording).toBeDefined();
  published.resolve();
  await stopping;
  // The old recording's "end may be incomplete" is not the running one's.
  expect(t.service.state("thread").recordingNotice).toBeUndefined();
  expect(t.service.state("thread").recording).toBeDefined();
});
