import { z } from "zod";
import type { BackendLog } from "./backend.ts";

const Console = z.object({
  type: z.string(),
  args: z
    .array(z.object({ value: z.unknown().optional(), description: z.string().optional() }))
    .max(128),
});
const Exception = z.object({ exceptionDetails: z.object({ text: z.string().max(8192) }) });

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
  return undefined;
}
