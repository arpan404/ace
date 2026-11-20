/* oxlint-disable unicorn/consistent-function-scoping -- the probe is serialized into the page as one function, so its helpers live inside it. */
import type { Page } from "@playwright/test";
import { z } from "zod";

/*
 * What the Deck budget run reads in the page (docs/editor/workbench.md 59). An init script, so
 * timing starts from the browser's own event timestamps and stops in the frame that shows the
 * result, never at a Playwright round trip:
 * - a switch: from a pointer press in a group (on a tab, or its Try again) until that group's
 *   editor shows the file's rows, noting whether the group showed its loading state meanwhile (a
 *   buffer the cap freed) or an error;
 * - typing: from each key press in an editor until the frame after it has painted;
 * - a load: from the shell reporting the daemon connected until every group's editor shows rows.
 */

declare global {
  // The page-side recorder the init script installs.
  var aceDeckProbe: DeckProbe | undefined;
}

interface DeckProbe {
  switches: Switch[];
  keys: number[];
  load: Load;
}

const Switch = z.object({
  path: z.string(),
  ms: z.number(),
  loading: z.boolean(),
  error: z.string().optional(),
});
type Switch = z.infer<typeof Switch>;

const Load = z.object({
  connectedAt: z.number().optional(),
  paintedAt: z.number().optional(),
  errors: z.array(z.string()),
});
type Load = z.infer<typeof Load>;

/**
 * Init script: installs `aceDeckProbe`. Runs on every load, before the app. It is serialized
 * into the page, so its helpers must live inside it.
 */
export function installDeckProbe() {
  const probe: DeckProbe = { switches: [], keys: [], load: { errors: [] } };
  globalThis.aceDeckProbe = probe;
  const groupOf = (target: EventTarget | null) =>
    target instanceof Element
      ? target.closest<HTMLElement>('[data-group-id]')
      : null;
  const editorOf = (group: Element) => group.querySelector('[data-part="deck-editor"]');
  /** The editor's rows for `path` are on screen. */
  const shows = (group: Element, path: string) => {
    const source = editorOf(group)?.querySelector(`[aria-label="Source of ${CSS.escape(path)}"]`);
    return (source?.textContent ?? "").includes("x=");
  };
  const failure = (group: Element) =>
    editorOf(group)?.querySelector('[role="status"]')?.textContent ?? undefined;
  const afterPaint = (done: (at: number) => void) =>
    requestAnimationFrame(() => setTimeout(() => done(performance.now()), 0));

  document.addEventListener(
    "pointerdown",
    (event) => {
      const group = groupOf(event.target);
      if (!group || !(event.target instanceof Element)) return;
      const tab = event.target.closest('[role="tab"][data-path]');
      const path = (tab ?? group.querySelector('[role="tab"][aria-selected="true"]'))?.getAttribute(
        "data-path",
      );
      if (!path) return;
      const from = event.timeStamp;
      let loading = false;
      const started = performance.now();
      const frame = () => {
        loading ||= editorOf(group)?.querySelector('[aria-label="Loading file"]') != null;
        if (shows(group, path))
          return afterPaint((at) => probe.switches.push({ path, ms: at - from, loading }));
        const error = loading || performance.now() - started > 200 ? failure(group) : undefined;
        if (error)
          return probe.switches.push({ path, ms: performance.now() - from, loading, error });
        if (performance.now() - started > 30_000)
          return probe.switches.push({ path, ms: Infinity, loading, error: "never painted" });
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    { capture: true },
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('[aria-label^="Source of "]')) return;
      const from = event.timeStamp;
      afterPaint((at) => probe.keys.push(at - from));
    },
    { capture: true },
  );

  // The load: connected, then every group's shown editor painted.
  const began = performance.now();
  const loadFrame = () => {
    const load = probe.load;
    if (
      load.connectedAt === undefined &&
      document.querySelector('[data-connection="ready"]') !== null
    )
      load.connectedAt = performance.now();
    const groups = [...document.querySelectorAll('[data-group-id]')];
    const errors = groups.flatMap((group) => {
      const text = failure(group);
      return text ? [text] : [];
    });
    if (errors.length > 0 && load.connectedAt !== undefined) {
      load.errors = errors;
      return;
    }
    const painted =
      groups.length > 0 &&
      groups.every((group) => {
        const path = group
          .querySelector('[role="tab"][aria-selected="true"]')
          ?.getAttribute("data-path");
        return path !== null && path !== undefined && shows(group, path);
      });
    if (painted && load.connectedAt !== undefined) return afterPaint((at) => (load.paintedAt = at));
    if (performance.now() - began < 60_000) requestAnimationFrame(loadFrame);
  };
  requestAnimationFrame(loadFrame);
}

const Probe = z.object({
  switches: z.array(Switch),
  keys: z.array(z.number()),
  load: Load,
});

export async function readProbe(page: Page) {
  return Probe.parse(await page.evaluate(() => globalThis.aceDeckProbe));
}

/** Waits for the switch after the `index`th recorded one. */
export async function nextSwitch(page: Page, index: number): Promise<Switch> {
  await page.waitForFunction((at) => (globalThis.aceDeckProbe?.switches.length ?? 0) > at, index, {
    timeout: 60_000,
  });
  const recorded = (await readProbe(page)).switches[index];
  if (!recorded) throw new Error(`No switch ${index}`);
  return recorded;
}

/** Waits for the page load's outcome: painted, failed, or a minute gone. */
export async function loadOutcome(page: Page): Promise<Load> {
  await page
    .waitForFunction(
      () => {
        const load = globalThis.aceDeckProbe?.load;
        return load !== undefined && (load.paintedAt !== undefined || load.errors.length > 0);
      },
      undefined,
      { timeout: 60_000 },
    )
    .catch(() => undefined);
  return (await readProbe(page)).load;
}

/** The `q` quantile of `values` (nearest rank). */
export function quantile(values: readonly number[], q: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
}
