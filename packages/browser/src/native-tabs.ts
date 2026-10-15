import { z } from "zod";
import { BrowserTab, browserTabLimit } from "@ace/protocol";

/** One desktop tab as the native view reports it; `viewport` is only known for embedded views. */
const NativeTab = BrowserTab.omit({ pending_dialog: true }).extend({
  viewport: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
});
export type NativeTab = z.infer<typeof NativeTab>;
export interface NativeTabsState {
  activeTabId: string;
  tabs: NativeTab[];
}
/** A decoded tab list, plus why any entries the desktop sent could not be kept. */
export interface NativeTabsDecoded {
  state: NativeTabsState;
  problems: string[];
}

const Envelope = z.object({ activeTabId: z.string(), tabs: z.array(z.unknown()) });
const Entry = z.object({
  tabId: BrowserTab.shape.tabId,
  url: z.string(),
  title: z.string().catch(""),
  viewport: NativeTab.shape.viewport.catch(undefined),
});
const urlLimit = 8192;
const titleLimit = 1024;

/**
 * Decodes the desktop's tab list leniently: an oversized URL or title is cut to the wire bound,
 * an entry without a usable id or URL is skipped and reported, and a list past the wire bound
 * keeps its first entries plus the active one. Returns undefined only when the frame is not a
 * tab list at all.
 */
export function decodeNativeTabs(raw: unknown): NativeTabsDecoded | undefined {
  const envelope = Envelope.safeParse(raw);
  if (!envelope.success) return undefined;
  const problems: string[] = [];
  const seen = new Set<string>();
  const decoded: NativeTab[] = [];
  let malformed = 0;
  for (const item of envelope.data.tabs) {
    const entry = Entry.safeParse(item);
    if (!entry.success || seen.has(entry.data.tabId)) {
      malformed++;
      continue;
    }
    seen.add(entry.data.tabId);
    const { viewport, ...tab } = entry.data;
    decoded.push({
      ...tab,
      url: tab.url.slice(0, urlLimit),
      title: tab.title.slice(0, titleLimit),
      ...(viewport ? { viewport } : {}),
    });
  }
  if (malformed > 0)
    problems.push(
      `${malformed} browser tab ${malformed === 1 ? "entry was" : "entries were"} malformed and skipped`,
    );
  const { activeTabId } = envelope.data;
  let tabs = decoded;
  if (decoded.length > browserTabLimit) {
    const kept = decoded.slice(0, browserTabLimit);
    const active = decoded.find((tab) => tab.tabId === activeTabId);
    if (active && !kept.includes(active)) kept[kept.length - 1] = active;
    tabs = kept;
    problems.push(
      `${decoded.length - browserTabLimit} browser tabs past the ${browserTabLimit}-tab limit are not tracked`,
    );
  }
  return { state: { activeTabId, tabs }, problems };
}
