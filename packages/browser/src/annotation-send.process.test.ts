import { expect, it, vi } from "vitest";
import { BrowserAnnotationCapture } from "@ace/protocol";
import { annotationFixture, executablePath } from "./annotation-test-support.ts";

const test = it.skipIf(!executablePath);
const overlayPresent = "document.querySelector('ace-annotation-layer') !== null";

/** Where the bar's Send is on screen: the right-most accent-filled run on the bar's row. */
async function sendButton(
  f: Awaited<ReturnType<typeof annotationFixture>>,
  person: ReturnType<Awaited<ReturnType<typeof annotationFixture>>["connect"]>,
): Promise<{ x: number; y: number }> {
  const width = Number(await person.evaluate("innerWidth"));
  const height = Number(await person.evaluate("innerHeight"));
  const { default: sharp } = await import("sharp");
  const shot = Buffer.from(await f.service.screenshot("thread"));
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / width;
  // The bar sits 16 px above the bottom and is 42 px tall: its middle row.
  const y = height - 37;
  const row = Math.round(y * scale);
  // The dark fixture's Send fill is #DEDEDE. Require a wide run followed
  // by dark bar pixels to exclude the white page and antialiased bar edge.
  const accent = 0xde;
  const tolerance = 14;
  const isSendFill = (r: number, g: number, b: number) =>
    Math.abs(r - accent) <= tolerance &&
    Math.abs(g - accent) <= tolerance &&
    Math.abs(b - accent) <= tolerance;
  const atPixel = (x: number) => {
    const at = (row * info.width + x) * info.channels;
    return [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0] as const;
  };
  const minRun = Math.max(6, Math.round(10 * scale));
  const edge = Math.max(3, Math.round(4 * scale));
  const runs: Array<{ left: number; right: number }> = [];
  let start = -1;
  for (let x = 0; x < info.width; x++) {
    const [r, g, b] = atPixel(x);
    const fill = isSendFill(r, g, b);
    if (fill && start < 0) start = x;
    if (!fill && start >= 0) {
      runs.push({ left: start, right: x - 1 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ left: start, right: info.width - 1 });
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (!run) continue;
    if (run.right - run.left + 1 < minRun) continue;
    const probe = Math.min(info.width - 1, run.right + edge);
    const [pr, pg, pb] = atPixel(probe);
    if (Math.max(pr, pg, pb) >= 200) continue;
    return { x: (run.left + run.right) / 2 / scale, y };
  }
  throw new Error("No Send button on the bar");
}

test("pressing Send on the page ends annotate mode even when the client never stops it", async () => {
  const f = await annotationFixture();
  const person = await f.annotating();
  await f.pin(person, "p.lead", "Send this");
  const send = await sendButton(f, person);
  await person.click(send.x, send.y);
  await person.event("send");
  // The person's client may still take its images; then the overlay goes on its own.
  expect(await person.event("ended")).toMatchObject({ reason: "stopped" });
  expect(f.service.state("thread").annotation).toBeUndefined();
  await vi.waitFor(async () => expect(await person.evaluate(overlayPresent)).toBe(false));
  expect(await person.evaluate("window.pageClicks")).toBe(0);
}, 60_000);

test("a person's annotate commands never wait behind an agent's input that waits for them", async () => {
  const f = await annotationFixture();
  const person = await f.annotating();
  await f.pin(person, "p.lead", "Tighter");
  // The person just used the page, so the agent's key press politely waits for a pause.
  const agent = f.service.execute("thread", { action: "press", key: "End" });
  let agentDone = false;
  void agent.then(
    () => (agentDone = true),
    () => (agentDone = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(agentDone).toBe(false);
  const capture = BrowserAnnotationCapture.parse(
    await person.execute({ action: "annotate_capture", target: { kind: "page" } }),
  );
  expect(capture.mimeType).toBe("image/jpeg");
  await person.execute({ action: "annotate", operation: "stop" });
  expect(await person.event("ended")).toMatchObject({ reason: "stopped" });
  expect(f.service.state("thread").annotation).toBeUndefined();
  // Both landed while the agent was still waiting for the person to pause.
  expect(agentDone).toBe(false);
  await agent.catch(() => {});
  expect(await person.evaluate(overlayPresent)).toBe(false);
}, 60_000);
