import { scheduleIdleWork, type IdleScheduler } from "@/lib/idle.ts";
import amsRegular from "katex/dist/fonts/KaTeX_AMS-Regular.woff2?url";
import { loadMath } from "./math-load.ts";
import mainRegular from "katex/dist/fonts/KaTeX_Main-Regular.woff2?url";
import mathItalic from "katex/dist/fonts/KaTeX_Math-Italic.woff2?url";
import size1Regular from "katex/dist/fonts/KaTeX_Size1-Regular.woff2?url";
import size2Regular from "katex/dist/fonts/KaTeX_Size2-Regular.woff2?url";

/*
 * Warming KaTeX before the first formula needs it. The chunk, its CSS and the
 * few woff2 fonts common math uses preload at idle, after the app is already
 * interactive — never on the critical startup path, and never on mobile or a
 * metered connection (`saveData`, very slow links). App boot schedules it
 * once the shell has rendered; the thread route schedules it alongside the
 * markdown chunk so the two downloads overlap; prose schedules it as a
 * backstop. Scheduling is idempotent: the first trigger wins. The moment the
 * streaming parser first sees a math delimiter it warms at once instead of
 * waiting for idle, still before the formula's block settles.
 */

/** The woff2 fonts common math (`\frac`, `\boxed`, super/subscripts) uses. */
export const mathFontUrls: readonly string[] = [
  mainRegular,
  mathItalic,
  size1Regular,
  size2Regular,
  amsRegular,
];

/** What decides warm-up; read from the platform at the call site, decided here. */
export interface WarmHints {
  saveData?: boolean | undefined;
  effectiveType?: string | undefined;
  mobile?: boolean | undefined;
}

/** No speculative downloads on a metered connection or a phone. */
export function shouldWarmMath(hints: WarmHints): boolean {
  if (hints.saveData) return false;
  if (hints.mobile) return false;
  if (hints.effectiveType === "slow-2g" || hints.effectiveType === "2g") return false;
  return true;
}

/** The platform's signals, gathered in one place so the decision stays pure. */
export function readWarmHints(): WarmHints {
  const nav = globalThis.navigator as unknown as
    | {
        connection?: { saveData?: boolean; effectiveType?: string };
        userAgentData?: { mobile?: boolean };
        userAgent?: string;
      }
    | undefined;
  if (!nav) return {};
  return {
    saveData: nav.connection?.saveData,
    effectiveType: nav.connection?.effectiveType,
    mobile:
      nav.userAgentData?.mobile ??
      (/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? "") || undefined),
  };
}

export type { IdleScheduler };

/** Where there is no idle callback, warm shortly after interactivity. */
const NO_IDLE_WARM_DELAY_MS = 1200;

/**
 * Run `work` once the page is idle (`timeoutMs` bounds the wait), or shortly
 * after interactivity where there is no idle callback. A `setTimeout` safety
 * net races the idle callback and cancels it: where idle callbacks never fire
 * (ace's own browser has that bug), the timeout still runs the work.
 * Whichever fires first wins; cancel stops both. Returns a cancel.
 */
export function scheduleWhenIdle(
  scheduler: IdleScheduler,
  work: () => void,
  timeoutMs = 3000,
): () => void {
  return scheduleIdleWork(scheduler, work, timeoutMs, NO_IDLE_WARM_DELAY_MS);
}

const realScheduler = (): IdleScheduler => ({
  ...(typeof globalThis.requestIdleCallback === "function"
    ? {
        requestIdleCallback: globalThis.requestIdleCallback.bind(globalThis),
        cancelIdle:
          typeof globalThis.cancelIdleCallback === "function"
            ? globalThis.cancelIdleCallback.bind(globalThis)
            : undefined,
      }
    : {}),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
});

/** Preload hints for the math fonts, once per document. */
export function preloadMathFonts(document: Document, urls: readonly string[]): void {
  const head = document.head;
  if (!head) return;
  for (const url of urls) {
    if (head.querySelector(`link[data-math-font="${CSS.escape(url)}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "font";
    link.type = "font/woff2";
    link.crossOrigin = "anonymous";
    link.href = url;
    link.dataset.mathFont = url;
    head.append(link);
  }
}

export interface WarmEnvironment {
  importMath: () => Promise<unknown>;
  document?: Document | undefined;
  fonts?: readonly string[] | undefined;
}

/** Load the KaTeX chunk now and preload its fonts; safe to call any number of times. */
export function warmMathNow(environment?: WarmEnvironment): Promise<void> {
  const full = { ...defaultEnvironment(), ...environment };
  if (full.document && full.fonts) preloadMathFonts(full.document, full.fonts);
  return full.importMath().then(
    () => {},
    () => {},
  );
}

export interface ScheduledWarmEnvironment extends WarmEnvironment {
  scheduler?: IdleScheduler | undefined;
  hints?: WarmHints | undefined;
}

const defaultEnvironment = (): ScheduledWarmEnvironment => ({
  scheduler: realScheduler(),
  hints: readWarmHints(),
  importMath: loadMath,
  document: globalThis.document,
  fonts: mathFontUrls,
});

/**
 * Warm KaTeX at idle, or not at all on mobile/metered links. The dynamic
 * import keeps KaTeX out of the initial bundle; this only schedules it.
 * Idempotent: boot, prose and the thread route all trigger it, and only the
 * first schedules. A gated-out call schedules nothing and consumes nothing.
 */
let warmupScheduled = false;
export function scheduleMathWarmup(
  environment?: Partial<ScheduledWarmEnvironment> | undefined,
): () => void {
  const full = { ...defaultEnvironment(), ...environment };
  if (warmupScheduled) return () => {};
  if (!shouldWarmMath(full.hints ?? {}) || !full.scheduler) return () => {};
  warmupScheduled = true;
  return scheduleWhenIdle(full.scheduler, () => void warmMathNow(full));
}
