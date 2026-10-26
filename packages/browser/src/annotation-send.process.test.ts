import { expect, it, vi } from "vitest";
import { BrowserAnnotationCapture } from "@ace/protocol";
import { designTokens } from "@ace/design-tokens";
import { annotationFixture, executablePath, isColour } from "./annotation-test-support.ts";

const test = it.skipIf(!executablePath);
const overlayPresent = "document.querySelector('ace-annotation-layer') !== null";

/**
 * Where the bar's Send is on screen. Annotate mode runs in the dark theme, so the bar is dark
 * glass and Send is the pill filled with the dark accent. On a row above the labels and icons,
 * the right-most accent run inside the glass is that pill.
 */
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
  // The bar sits 16 px above the bottom and is 42 px tall: its middle row. Send is 30 px tall
  // and its 16 px icons and 13 px label leave the row 10 px above the middle clear.
  const y = height - 37;
  const row = Math.round((y - 10) * scale);
  const accent = designTokens.schemes.dark.colours.accent;
  let inBar = false;
  let right = -1;
  let left = -1;
  for (let x = info.width - 1; x >= 0; x--) {
    const at = (row * info.width + x) * info.channels;
    const rgb: [number, number, number] = [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0];
    if (!inBar) {
      // The page and the bar's shadow are bright; the glass is dark.
      inBar = Math.max(...rgb) < 128;
      continue;
    }
    const fill = isColour(rgb, accent);
    if (fill && right < 0) right = x;
    if (!fill && right >= 0) {
      left = x + 1;
      break;
    }
  }
  if (right < 0 || left < 0) throw new Error("No Send button on the bar");
  return { x: (left + right) / 2 / scale, y };
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
