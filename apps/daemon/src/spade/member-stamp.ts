import { createHash, createHmac } from "node:crypto";

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

/*
 * Any other write a member makes on an organization's host (ADR 0206 §2.3): a message, a grant,
 * a bot's access list, its Full access, a move. Spade takes one to a shared bot only with
 * `x-ace-member-request: v1.<ms>.<nonce>.<account>.<hex HMAC>` over the request itself
 * (`<METHOD> <path>`, the SHA-256 of its body) and the member's role, sent in
 * `x-ace-member-role` and signed with the rest, so a stamp moved to another route, body, member
 * or role counts for nothing. The daemon holds no access list: it stamps any write of a socket
 * whose member standing is current, and Spade checks the member's right on that bot itself
 * (`spade/docs/orgs.md`).
 */

export const memberRequestHeader = "x-ace-member-request";
export const memberRoleHeader = "x-ace-member-role";

/** A write as Spade reads it for its stamp. */
export interface MemberRequest {
  method: string;
  /** The path sent, query and all; the stamp signs it without the query. */
  path: string;
  body: Buffer | undefined;
}

/** The member a stamp names: their WorkOS account and their role's slug in the organization. */
export interface StampedMember {
  account: string;
  role: string;
}

/** Role slugs as Spade takes them under the stamp. */
const stampRole = /^[A-Za-z0-9_:-]{1,64}$/;

/** The text a write's stamp signs, as Spade spells it (`security::member`). */
export function memberRequestText(
  write: MemberRequest,
  member: StampedMember,
  atMs: number,
  nonce: string,
): string {
  const path = write.path.split("?")[0] ?? "";
  const digest = createHash("sha256")
    .update(write.body ?? Buffer.alloc(0))
    .digest("hex");
  return `ace-spade-member-request/1\n${write.method} ${path}\n${digest}\n${member.account}\n${member.role}\n${atMs}\n${nonce}`;
}

/**
 * The headers that stamp `write` as `member`'s, or undefined for an account or role the stamp
 * can't carry (Spade would refuse it, so nothing is sent as theirs).
 */
export function memberRequestStamp(
  key: Uint8Array,
  write: MemberRequest,
  member: StampedMember,
  atMs: number,
  nonce: string,
): Record<string, string> | undefined {
  if (!stampAccount.test(member.account) || !stampRole.test(member.role)) return undefined;
  const mac = createHmac("sha256", key)
    .update(memberRequestText(write, member, atMs, nonce))
    .digest("hex");
  return {
    [memberRequestHeader]: `v1.${atMs}.${nonce}.${member.account}.${mac}`,
    [memberRoleHeader]: member.role,
  };
}
