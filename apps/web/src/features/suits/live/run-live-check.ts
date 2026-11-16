import {
  maxSuitScreenshotChars,
  type SuitLiveCheck,
  type SuitLiveReport,
  type SuitScreenshot,
} from "@ace/protocol/suits";
import { contrastProblems } from "./colour-check.ts";
import { colourReader, readColours, readOverflow, readProtected } from "./collect.ts";
import { overflowProblems, protectedProblems, type OverflowSample } from "./layout-check.ts";
import { sampleScenes } from "./scene-sample.ts";

/*
 * One live check of the Suit on screen (ADR 0150, "Shown perfectly"), run when the daemon asks
 * (`suitCheck`). Contrast and protected parts are read at the window's own width. Overflow is
 * read there and at two narrower widths made by narrowing the app's container for a moment:
 * a page can't resize its window, so media queries keep the real width and say so in the
 * problem. Then the window is captured where the desktop app can.
 */

/** Window widths the layout is checked at, besides the real one (only those narrower). */
export const simulatedWidths = [1024, 760] as const;

export type Capture = (request: {
  maxWidth: number;
  quality: number;
}) => Promise<{ data: string; width: number; height: number } | undefined>;

const frames = (view: Window, count: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      left === 0 ? resolve() : view.requestAnimationFrame(() => step(left - 1));
    step(count);
  });
const pause = (view: Window, ms: number) =>
  new Promise<void>((resolve) => view.setTimeout(resolve, ms));

/** Overflow at `width`, with the app's container narrowed to it and put back after. */
async function overflowAt(app: HTMLElement, view: Window, width: number) {
  const before = { width: app.style.width, maxWidth: app.style.maxWidth };
  app.style.setProperty("width", `${width}px`, "important");
  app.style.setProperty("max-width", `${width}px`, "important");
  try {
    // Resize observers and layout settle over a couple of frames.
    await frames(view, 2);
    await pause(view, 60);
    return readOverflow(app);
  } finally {
    app.style.width = before.width;
    app.style.maxWidth = before.maxWidth;
  }
}

async function screenshot(
  capture: Capture | undefined,
): Promise<{ screenshot: SuitScreenshot | null; note?: string }> {
  if (!capture)
    return {
      screenshot: null,
      note: "This is a browser tab, which can't capture itself without asking the person; use browser_screenshot on ace's web app to see it.",
    };
  for (const request of [
    { maxWidth: 1440, quality: 72 },
    { maxWidth: 1024, quality: 60 },
  ]) {
    const image = await capture(request).catch(() => undefined);
    if (!image) return { screenshot: null, note: "The desktop app couldn't capture its window." };
    if (image.data.length <= maxSuitScreenshotChars)
      return { screenshot: { mimeType: "image/jpeg", ...image } };
  }
  return { screenshot: null, note: "The window's capture was too large to send." };
}

export async function runLiveCheck(input: {
  check: SuitLiveCheck;
  document: Document;
  scheme: "light" | "dark";
  capture: Capture | undefined;
}): Promise<SuitLiveReport> {
  const { check, document, scheme, capture } = input;
  const view = document.defaultView;
  const root =
    document.querySelector<HTMLElement>(`[data-suit="${check.suitId}"]`) ?? document.body;
  const app = root.matches('[data-part="app"]')
    ? root
    : (root.querySelector<HTMLElement>('[data-part="app"]') ?? root);
  const scenes = await sampleScenes(document);
  const colours = readColours(root, scenes, colourReader(document));
  const problems = [
    ...contrastProblems(colours.samples, scheme),
    ...protectedProblems(readProtected(root, document), scheme),
  ];
  const width = Math.round(view?.innerWidth ?? app.getBoundingClientRect().width);
  const measured: { width: number; simulated: boolean; samples: OverflowSample[] }[] = [
    { width, simulated: false, samples: readOverflow(root) },
  ];
  if (view)
    for (const narrower of simulatedWidths.filter((each) => each < width))
      measured.push({
        width: narrower,
        simulated: true,
        samples: await overflowAt(app, view, narrower),
      });
  problems.push(...overflowProblems(measured, scheme));
  if (view) await frames(view, 2);
  const shot = await screenshot(capture);
  return {
    checkId: check.checkId,
    suitId: check.suitId,
    client: capture ? "desktop" : "web",
    scheme,
    widths: measured.map((entry) => entry.width),
    problems: problems.slice(0, 200),
    unchecked: colours.unchecked.slice(0, 100),
    screenshot: shot.screenshot,
    ...(shot.note ? { screenshotNote: shot.note } : {}),
  };
}
