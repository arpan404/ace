import { spadeRecord } from "./json.ts";

/*
 * A request worded from what the call does, not from the tool's name (ADR 0217, build notes):
 * a payment says who it pays and how much ("pay €412 to TAP Air Portugal"), and a step in a page
 * or app says what it presses ("pay €412 to TAP Air Portugal" for a button that reads so;
 * otherwise "press “Continue” on a web page"). Undefined when the call doesn't say enough.
 */

/** Words a button's label leads with that say what pressing it does. */
const actionVerbs = new Set([
  "accept",
  "approve",
  "book",
  "buy",
  "cancel",
  "checkout",
  "confirm",
  "delete",
  "donate",
  "order",
  "pay",
  "place",
  "post",
  "publish",
  "purchase",
  "remove",
  "renew",
  "reserve",
  "send",
  "sign",
  "submit",
  "subscribe",
  "transfer",
]);

/** Page and app steps (Spade's and ace's), by the place they press in. */
const stepPlace: Record<string, string> = {
  browser_act: "a web page",
  screen_act: "an app on the screen",
};

const pressing = new Set(["click", "press", "tap"]);

const words = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim().replaceAll(/\s+/g, " ") : undefined;

/** An amount with its currency when it comes apart (`{amount: 412, currency: "EUR"}`). */
function amountOf(fields: Record<string, unknown>): string | undefined {
  const raw = fields.amount ?? fields.total ?? fields.price;
  if (typeof raw === "string") return words(raw);
  if (typeof raw !== "number") return undefined;
  const currency = words(fields.currency);
  if (!currency) return String(raw);
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(raw);
  } catch {
    return `${raw} ${currency}`;
  }
}

function payment(name: string, fields: Record<string, unknown>, effect: string | undefined) {
  if (effect !== "pay" && !/(^|_)(pay|payment|checkout)(_|$)/.test(name)) return undefined;
  const amount = amountOf(fields);
  const payee = words(fields.payee) ?? words(fields.merchant) ?? words(fields.to);
  if (!amount || !payee) return undefined;
  return `pay ${amount} to ${payee}`;
}

function step(name: string, fields: Record<string, unknown>) {
  const place = stepPlace[name.replace(/^ace__/, "")];
  const action = words(fields.action)?.toLowerCase();
  if (!place || (action && !pressing.has(action))) return undefined;
  const label = words(fields.target) ?? words(fields.element) ?? words(fields.label);
  if (!label || label.length > 80) return undefined;
  const first = label.split(" ")[0]?.toLowerCase() ?? "";
  if (actionVerbs.has(first)) return first + label.slice(first.length);
  return `press “${label}” on ${place}`;
}

/** What the call does, as the verb phrase a request's sentence takes after "wants to". */
export function spadeRequestAct(
  name: string,
  args: unknown,
  effect: string | undefined,
): string | undefined {
  const fields = spadeRecord(args);
  if (!fields) return undefined;
  return payment(name, fields, effect) ?? step(name, fields);
}
