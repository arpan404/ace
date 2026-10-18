import { z } from "zod";
import type { BackendLog } from "./backend.ts";

const Console = z.object({
  type: z.string(),
  args: z
    .array(z.object({ value: z.unknown().optional(), description: z.string().optional() }))
    .max(128),
});
const Exception = z.object({ exceptionDetails: z.object({ text: z.string().max(8192) }) });
const Entry = z.object({
  entry: z.object({
    source: z.string().max(64),
    level: z.string().max(32),
    text: z.string(),
    url: z.string().optional(),
  }),
});
/**
 * The page events a tab logs: console calls, uncaught errors, and the browser's own messages
 * about the page (`Log`: mixed content, CSP and certificate warnings, interventions).
 */
export const consoleEvents = [
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Log.entryAdded",
] as const;

/** A page's console call or uncaught error as a bounded log line; other events give nothing. */
export function consoleEntry(method: string, params: unknown): BackendLog | undefined {
  if (method === "Runtime.consoleAPICalled") {
    const parsed = Console.safeParse(params);
    if (!parsed.success) return undefined;
    return {
      kind: "console",
      type: parsed.data.type,
      text: parsed.data.args
        .map((arg) => String(arg.value ?? arg.description ?? "").slice(0, 8192))
        .join(" ")
        .slice(0, 8192),
    };
  }
  if (method === "Runtime.exceptionThrown") {
    const parsed = Exception.safeParse(params);
    if (!parsed.success) return undefined;
    return { kind: "console", type: "pageerror", text: parsed.data.exceptionDetails.text };
  }
  if (method === "Log.entryAdded") {
    const parsed = Entry.safeParse(params);
    if (!parsed.success) return undefined;
    const { source, level, text, url } = parsed.data.entry;
    // Typed by level, as console calls are, so a `warning` filter finds both.
    return {
      kind: "console",
      type: level,
      text: `[${source}] ${text}`.slice(0, 8192),
      ...(url ? { url: url.slice(0, 8192) } : {}),
    };
  }
  return undefined;
}
