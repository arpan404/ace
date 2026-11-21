import { createHmac } from "node:crypto";

/*
 * A member's answer on an organization's host (ADR 0206 §2.3): Spade takes an answer to a shared
 * bot's raised request only with `x-ace-member: v1.<ms>.<nonce>.<account>.<hex HMAC>`, the person
 * stamp of ADR 0163 amendment 2 with the member's account added under the HMAC (same key,
 * `spade-person.key`). The daemon adds it only from a socket whose member standing is current, so
 * an answer sent once that standing ended (the member deprovisioned, their last grant run out)
 * is refused before it reaches Spade. Pure.
 */

export const memberHeader = "x-ace-member";

/** An answer to a raised request: which one, and what was answered. */
export interface AnswerWrite {
  /** `approval:<conversation>:<call>` or `outside:<conversation>:<ask>`. */
  target: string;
  /** `allowed=<bool>;always=<bool>`, as Spade reads the body (`always` defaults to false). */
  value: string;
}

const approval = /^\/v1\/conversations\/([^/?#]+)\/approvals\/([^/?#]+)$/;
const outside = /^\/v1\/conversations\/([^/?#]+)\/plugin_outside\/([^/?#]+)$/;
/** WorkOS user ids, as the stamp carries them between dots. */
const stampAccount = /^[A-Za-z0-9_-]{1,128}$/;

/** The answer a request makes, whatever its body; undefined for every other request. */
export function answerRoute(method: string, path: string): string | undefined {
  if (method !== "POST") return undefined;
  const bare = path.split("?")[0] ?? "";
  for (const [kind, route] of [
    ["approval", approval],
    ["outside", outside],
  ] as const) {
    const matched = route.exec(bare);
    if (!matched) continue;
    try {
      return `${kind}:${decodeURIComponent(matched[1] ?? "")}:${decodeURIComponent(matched[2] ?? "")}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The answer a `spade.http` request gives a raised request, read as Spade reads its body. */
export function answerWrite(
  method: string,
  path: string,
  body: Buffer | undefined,
): AnswerWrite | undefined {
  const target = answerRoute(method, path);
  if (target === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = body === undefined ? undefined : (JSON.parse(body.toString("utf8")) as unknown);
  } catch {
    parsed = undefined;
  }
  const field = (name: string) =>
    parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, name) : undefined;
  const allowed = field("allowed");
  const always = field("always");
  // Spade refuses a body it can't read; the stamp then names nothing it would act on.
  if (typeof allowed !== "boolean" || (always !== undefined && typeof always !== "boolean"))
    return { target, value: "unreadable" };
  return { target, value: `allowed=${allowed};always=${always === true}` };
}

/** The stamp Spade checks, or undefined for an account the stamp can't carry. */
export function memberStamp(
  key: Uint8Array,
  write: AnswerWrite,
  account: string,
  atMs: number,
  nonce: string,
): string | undefined {
  if (!stampAccount.test(account)) return undefined;
  const mac = createHmac("sha256", key)
    .update(`ace-spade-member/1\n${write.target}\n${write.value}\n${account}\n${atMs}\n${nonce}`)
    .digest("hex");
  return `v1.${atMs}.${nonce}.${account}.${mac}`;
}
