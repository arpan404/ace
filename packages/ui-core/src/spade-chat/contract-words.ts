/*
 * A contract call in words (ADR 0200 §7): the caller's one line ("Asked Flight watcher:
 * cheapest_fare") with what came back, and the callee's view of the request, which is the
 * calling bot's, never the person's. Pure, and free of the fold so the fold can use it.
 */

/** The tool a bot calls another bot's contract with. */
export const spadeContractTool = "contract_call";

/** How a call ended: its output came back, it failed, or it was stopped. */
export type SpadeContractOutcome = "returned" | "failed" | "stopped";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A value as a few plain words: text as it is, a list counted, an object's fields joined. */
function said(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  const fields = record(value);
  if (fields) return fieldsLine(fields);
  return "";
}

/** `fare 182 · currency USD`: an object's fields as one line, at most `limit` characters. */
export function fieldsLine(fields: Record<string, unknown>, limit = 160): string {
  const line = Object.entries(fields)
    .map(([key, value]) => `${key.replaceAll("_", " ")} ${said(value)}`.trim())
    .join(" · ");
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/** The caller's line: who it asked and which contract, and how that went. */
export function spadeContractLine(call: {
  bot: string;
  machine?: string | undefined;
  contract: string;
  outcome: SpadeContractOutcome | undefined;
}): string {
  const bot = call.machine ? `${call.bot} on ${call.machine}` : call.bot;
  switch (call.outcome) {
    case undefined:
      return `Asking ${bot}: ${call.contract}`;
    case "returned":
      return `Asked ${bot}: ${call.contract}`;
    case "failed":
      return `${bot} couldn't answer ${call.contract}`;
    case "stopped":
      return `Stopped asking ${bot}: ${call.contract}`;
  }
}

/** What a `<contract_result>` says, read back: its status and body. */
export function spadeContractResult(content: string): {
  outcome: SpadeContractOutcome;
  /** The output's fields in one line, or why it failed or stopped. */
  result: string;
} {
  const status = /status="(returned|failed|stopped)"/.exec(content)?.[1];
  const body = content
    .replace(/^<contract_result[^>]*>\n?/, "")
    .replace(/\n?<\/contract_result>\s*$/, "")
    .trim();
  const outcome: SpadeContractOutcome =
    status === "returned" || status === "stopped" ? status : "failed";
  if (outcome !== "returned") return { outcome, result: body.split("\n")[0] ?? "" };
  try {
    const output: unknown = JSON.parse(body);
    const fields = record(output);
    return { outcome, result: fields ? fieldsLine(fields) : said(output) };
  } catch {
    return { outcome, result: body.split("\n")[0] ?? "" };
  }
}

/** What the callee's chat shows for a call it was given: the contract and its input's fields. */
export function spadeContractAsk(contract: string, input: unknown): string {
  const fields = record(input);
  const given = fields ? fieldsLine(fields) : said(input);
  return given ? `Asked for ${contract}: ${given}` : `Asked for ${contract}`;
}
