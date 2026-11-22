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

const currencies: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", JPY: "¥", INR: "₹" };
const amountKey = /^(fare|price|cost|amount|total|rate|fee)$/i;
const placeKey = /^(carrier|provider|airline|vendor|seller|store|shop)$/i;

/** A contract's name in words: `cheapest_room` reads "cheapest room". */
export function spadeContractName(name: string): string {
  return name.replaceAll(/[_-]+/g, " ").trim();
}

/** 78 and EUR as "€78"; an unknown currency code goes after the number ("78 CHF"). */
function money(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const mark = currencies[code];
  return mark ? `${mark}${amount}` : `${amount} ${code}`;
}

/**
 * An object's fields as a short phrase, never as raw keys: an amount with its currency reads
 * "€78", a seller after it "with TAP", the rest by value ("Lisbon, 2 nights" from city and
 * nights keeps only values). Moments ("seen_at") are left out. At most `limit` characters.
 */
export function fieldsLine(fields: Record<string, unknown>, limit = 160): string {
  const entries = Object.entries(fields).filter(([key]) => !/(^|_)(at|time)$/i.test(key));
  const amount = entries.find(([key, value]) => amountKey.test(key) && typeof value === "number");
  const currency = entries.find(([key, value]) => /^currency$/i.test(key) && typeof value === "string");
  const seller = entries.find(([key, value]) => placeKey.test(key) && typeof value === "string");
  const used = new Set<string>();
  const parts: string[] = [];
  if (amount && currency) {
    parts.push(money(amount[1] as number, currency[1] as string));
    used.add(amount[0]).add(currency[0]);
    if (seller) {
      parts[0] += ` with ${seller[1] as string}`;
      used.add(seller[0]);
    }
  }
  for (const [key, value] of entries) {
    if (used.has(key)) continue;
    const words = said(value);
    if (words) parts.push(typeof value === "number" ? `${words} ${key.replaceAll("_", " ")}` : words);
  }
  const line = parts.join(", ");
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
  const contract = spadeContractName(call.contract);
  switch (call.outcome) {
    case undefined:
      return `Asking ${bot}: ${contract}`;
    case "returned":
      return `Asked ${bot}: ${contract}`;
    case "failed":
      return `${bot} couldn't answer ${contract}`;
    case "stopped":
      return `Stopped asking ${bot}: ${contract}`;
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
  const name = spadeContractName(contract);
  return given ? `Asked for ${name}: ${given}` : `Asked for ${name}`;
}
