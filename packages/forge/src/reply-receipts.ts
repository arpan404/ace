import { createHash } from "node:crypto";
import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol";
import type { GhApi } from "./http.ts";
import { ForgeMutationOutcome } from "./mutation.ts";

export interface ReplyReceipts {
  account: string;
  get(intent: string): { id: number; account: string } | undefined;
  put(intent: string, id: number): void;
  remove(intent: string): void;
}
export function replyIntent(repository: ForgeRepository, number: number, commentId: number, body: string): string {
  return createHash("sha256").update(JSON.stringify([repository, number, commentId, body])).digest("hex");
}
const reply = z.object({
  id: z.number().int().positive(), body: z.string().max(65_536),
  in_reply_to_id: z.number().int().positive(), user: z.object({ login: z.string().max(100) }),
});

/** An outstanding receipt is reconciled by its remote ID before any further reply write. */
export async function reconcileReply(
  api: GhApi, root: string, receipt: { id: number; account: string },
  expected: { account: string; body: string; commentId: number }, signal: AbortSignal,
): Promise<void> {
  try {
    if (receipt.account !== expected.account) throw new Error("identity_changed");
    const response = await api.request(`${root}/pulls/comments/${receipt.id}`, signal);
    const value = reply.parse(response.body);
    if (value.id !== receipt.id || value.body !== expected.body || value.in_reply_to_id !== expected.commentId || value.user.login !== receipt.account)
      throw new Error("reply_changed");
  } catch {
    throw new ForgeMutationOutcome({ id: receipt.id });
  }
}
