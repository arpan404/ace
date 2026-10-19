import { z } from "zod";
import {
  browserCursors,
  BrowserPageFocus,
  BrowserPageRect,
  BrowserPageTooltip,
  BrowserPickerKind,
  BrowserPickerOption,
  type BrowserCursor,
  type BrowserPagePicker,
  type BrowserPageState,
} from "@ace/protocol";
import type { BrowserCdp } from "./backend.ts";
import {
  pageBinding,
  pageInteractionSource,
  pageWorld,
  pickFunction,
} from "./page-interaction-script.ts";

/*
 * A tab's page state for remote views (`browser.page`): the focused field, an open picker, the
 * cursor shape and a tooltip. The page reports through a binding only ace's isolated world can
 * call (`page-interaction-script.ts`); `readPageReport` and `reducePage` turn those reports into
 * state without any I/O, and `PageInteraction` is the thin CDP shell around them.
 */

const BindingCall = z.object({ name: z.string(), payload: z.string().max(256 * 1024) });
const Navigated = z.object({ frame: z.object({ parentId: z.string().optional() }) });
const Added = z.object({ identifier: z.string() });
const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) });
const World = z.object({ executionContextId: z.number().int() });
const Evaluated = z.object({ result: z.object({ value: z.unknown().optional() }) });
const cursorNames = new Set<string>(browserCursors);

/** A picker as the page reports it: `seq` names it within its document. */
const ReportedPicker = z.object({
  seq: z.number().int().nonnegative(),
  kind: BrowserPickerKind,
  rect: BrowserPageRect,
  value: z.string().max(4096).catch(""),
  // Options the wire can't carry are dropped one by one, never the whole picker.
  options: z
    .array(z.unknown())
    .max(1000)
    .transform((entries) =>
      entries.flatMap((entry) => {
        const option = BrowserPickerOption.safeParse(entry);
        return option.success ? [option.data] : [];
      }),
    )
    .optional(),
  min: z.string().max(64).optional().catch(undefined),
  max: z.string().max(64).optional().catch(undefined),
  step: z.string().max(64).optional().catch(undefined),
});
const Report = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("focus"), focus: BrowserPageFocus.nullable() }),
  z.object({
    kind: z.literal("cursor"),
    // A cursor image (`url(…)`) or a name this daemon doesn't send reads as the arrow.
    cursor: z
      .string()
      .max(256)
      .transform((name): BrowserCursor => (cursorNames.has(name) ? name : "default")),
  }),
  z.object({ kind: z.literal("tooltip"), tooltip: BrowserPageTooltip.nullable() }),
  z.object({ kind: z.literal("picker"), picker: ReportedPicker.nullable() }),
]);
export type PageReport = z.infer<typeof Report>;

/** What a binding call from the page world reports, or undefined when it is not one. */
export function readPageReport(raw: unknown): PageReport | undefined {
  const call = BindingCall.safeParse(raw);
  if (!call.success || call.data.name !== pageBinding) return undefined;
  try {
    const report = Report.safeParse(JSON.parse(call.data.payload));
    return report.success ? report.data : undefined;
  } catch {
    return undefined;
  }
}

export interface PageInteractionState {
  page: BrowserPageState;
  /** The page's own number for the open picker, which `pick` answers. */
  pickerSeq?: number | undefined;
}
export const emptyPageState: PageInteractionState = { page: {} };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function withField<K extends keyof BrowserPageState>(
  page: BrowserPageState,
  key: K,
  value: BrowserPageState[K] | undefined,
): BrowserPageState {
  const next = { ...page };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * The page state after one report. The same object comes back when nothing a client sees
 * changed, so callers send only real changes. A newly opened picker takes an id from `pickerId`.
 */
export function reducePage(
  current: PageInteractionState,
  report: PageReport,
  pickerId: () => string,
): PageInteractionState {
  switch (report.kind) {
    case "focus": {
      const focus = report.focus ?? undefined;
      if (same(focus, current.page.focus)) return current;
      return { ...current, page: withField(current.page, "focus", focus) };
    }
    case "cursor":
      if (report.cursor === (current.page.cursor ?? "default")) return current;
      return {
        ...current,
        page: withField(
          current.page,
          "cursor",
          report.cursor === "default" ? undefined : report.cursor,
        ),
      };
    case "tooltip": {
      const tooltip = report.tooltip ?? undefined;
      if (same(tooltip, current.page.tooltip)) return current;
      return { ...current, page: withField(current.page, "tooltip", tooltip) };
    }
    case "picker": {
      if (!report.picker) {
        if (!current.page.picker) return current;
        return { page: withField(current.page, "picker", undefined) };
      }
      const { seq, options, ...rest } = report.picker;
      const picker: BrowserPagePicker = {
        pickerId: pickerId(),
        ...rest,
        ...(options ? { options } : {}),
      };
      // The tooltip under the pointer goes once the person opens a picker.
      const page = withField(withField(current.page, "tooltip", undefined), "picker", picker);
      return { page, pickerSeq: seq };
    }
  }
}

/**
 * Follows one tab's page state on the CDP session that reaches its page now; `watch` again after
 * that session is replaced. A new document starts with none. Best effort: an engine that
 * refuses the binding or the script reports nothing, and the view keeps its defaults.
 */
export class PageInteraction {
  private current: PageInteractionState = emptyPageState;
  private cdp: BrowserCdp | undefined;
  private stop = () => {};
  private changed: (page: BrowserPageState) => void;
  private id: () => string;
  constructor(changed: (page: BrowserPageState) => void, id: () => string) {
    this.changed = changed;
    this.id = id;
  }
  get state(): BrowserPageState {
    return this.current.page;
  }
  private set(next: PageInteractionState): void {
    if (next === this.current) return;
    this.current = next;
    this.changed(next.page);
  }
  watch(cdp: BrowserCdp): void {
    this.stop();
    this.cdp = cdp;
    // What the old session reported may no longer hold; the page reports afresh as it changes.
    this.set(emptyPageState);
    let stopped = false;
    let script: string | undefined;
    const reported = (raw: unknown) => {
      const report = readPageReport(raw);
      if (!report || stopped) return;
      this.set(reducePage(this.current, report, this.id));
    };
    const navigated = (raw: unknown) => {
      const frame = Navigated.safeParse(raw);
      if (stopped || !frame.success || frame.data.frame.parentId) return;
      this.set(emptyPageState);
    };
    cdp.on("Runtime.bindingCalled", reported);
    cdp.on("Page.frameNavigated", navigated);
    this.stop = () => {
      stopped = true;
      cdp.off("Runtime.bindingCalled", reported);
      cdp.off("Page.frameNavigated", navigated);
      if (script)
        void cdp
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script })
          .catch(() => {});
    };
    void (async () => {
      await cdp.send("Runtime.addBinding", { name: pageBinding, executionContextName: pageWorld });
      const added = Added.safeParse(
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
          source: pageInteractionSource,
          worldName: pageWorld,
          runImmediately: true,
        }),
      );
      if (!added.success) return;
      if (stopped)
        void cdp
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: added.data.identifier })
          .catch(() => {});
      else script = added.data.identifier;
    })().catch(() => {});
  }
  /**
   * The person's choice in the open picker: the first of `values` is set on the element and its
   * `input` and `change` events fire. No values dismisses the picker and leaves the value.
   */
  async pick(pickerId: string, values: readonly string[] | undefined): Promise<void> {
    const seq = this.current.pickerSeq;
    const cdp = this.cdp;
    if (this.current.page.picker?.pickerId !== pickerId || seq === undefined || !cdp)
      throw new Error("The picker is no longer open");
    this.set({ page: withField(this.current.page, "picker", undefined) });
    // The world was made for the script by name; asking for it by name again returns it.
    const frame = FrameTree.parse(await cdp.send("Page.getFrameTree")).frameTree.frame.id;
    const world = World.parse(
      await cdp.send("Page.createIsolatedWorld", { frameId: frame, worldName: pageWorld }),
    );
    const evaluated = Evaluated.parse(
      await cdp.send("Runtime.evaluate", {
        contextId: world.executionContextId,
        expression: `globalThis.${pickFunction}?.(${seq}, ${JSON.stringify(values ?? [])}) ?? "gone"`,
        returnByValue: true,
      }),
    );
    const outcome = evaluated.result.value;
    if (outcome === "gone") throw new Error("The picker is no longer open");
    if (outcome === "invalid") throw new Error("That option isn't in the list");
  }
  close(): void {
    this.stop();
    this.stop = () => {};
    this.cdp = undefined;
  }
}
