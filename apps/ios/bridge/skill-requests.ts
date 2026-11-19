import type { ClientCore } from "@ace/client";
import type { SkillOperation, SkillResult } from "@ace/protocol";
import type { z } from "zod";

/*
 * One `skills.request` to the machine, for the phone's skill modules: the reply's result, or
 * the daemon's refusal thrown with its code so each screen can say it as it is.
 */

export type SkillOwner = Pick<ClientCore, "request">;
type Operation = z.input<typeof SkillOperation>;
const wait = { timeoutMs: 20_000 };

/** A refusal said as it is; anything else thrown means the machine didn't answer. */
export class Refused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function skills(owner: SkillOwner, operation: Operation, signal: AbortSignal) {
  const reply = await owner.request({ type: "skills.request", operation }, { ...wait, signal });
  return reply.result;
}

/** The result as `kind`, or a refusal: the daemon's own, or one for an unexpected answer. */
export function expect<K extends SkillResult["kind"]>(result: SkillResult, kind: K) {
  if (result.kind === "error") throw new Refused(result.code, result.message);
  if (result.kind !== kind)
    throw new Refused("unavailable", "The machine answered something else.");
  return result as Extract<SkillResult, { kind: K }>;
}
