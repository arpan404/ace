import { repositoryKey } from "./store.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol";
import type { GhApi } from "./http.ts";
import { ReadBudget } from "./read-budget.ts";
import { ForgeMutationOutcome } from "./mutation.ts";
import { ForgeError } from "./errors.ts";

/** `at` is when the reply was reserved; an unconfirmed reply expires after the write window. */
export type ReplyReceipt = { id: number | null; account: string; before: number; at: number };
export interface ReplyReceipts {
  account: string;
  get(intent: string): ReplyReceipt | undefined;
  reserve(intent: string, before: number, at: number): boolean;
  put(intent: string, id: number): void;
  remove(intent: string): void;
}
export function replyIntent(
  repository: ForgeRepository,
  number: number,
  commentId: number,
  body: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([repositoryKey(repository), number, commentId, body]))
    .digest("hex");
}
const comment = z.object({
  id: z.number().int().positive(),
  body: z.string().max(65_536),
  in_reply_to_id: z.number().int().positive().optional(),
  user: z.object({ login: z.string().max(100) }).nullable(),
});
async function comments(api: GhApi, root: string, number: number, signal: AbortSignal) {
  const pages = await api.pages(
    `${root}/pulls/${number}/comments?per_page=100`,
    signal,
    new ReadBudget(),
  );
  return pages.flatMap((page) => z.array(comment).max(100).parse(page.body));
}
export async function replyCutoff(
  api: GhApi,
  root: string,
  number: number,
  signal: AbortSignal,
): Promise<number> {
  return (await comments(api, root, number, signal)).reduce(
    (last, value) => Math.max(last, value.id),
    0,
  );
}
/** An outstanding receipt is reconciled before any further reply write, including lost responses.
 * Returns the reply's ID, or null when a complete read shows no such reply. A failed read or a
 * changed account proves nothing and stays uncertain. */
export async function reconcileReply(
  api: GhApi,
  root: string,
  receipt: ReplyReceipt,
  expected: { account: string; body: string; commentId: number; number: number },
  signal: AbortSignal,
): Promise<number | null> {
  let values: z.infer<typeof comment>[];
  try {
    if (receipt.account !== expected.account) throw new Error("identity_changed");
    values =
      receipt.id === null
        ? await comments(api, root, expected.number, signal)
        : [comment.parse((await api.request(`${root}/pulls/comments/${receipt.id}`, signal)).body)];
  } catch (error) {
    if (receipt.id !== null && error instanceof ForgeError && error.kind === "not_found")
      return null;
    throw new ForgeMutationOutcome({ id: receipt.id });
  }
  const matches = values.filter(
    (value) =>
      value.id > receipt.before &&
      value.body === expected.body &&
      value.in_reply_to_id === expected.commentId &&
      value.user?.login === receipt.account &&
      (receipt.id === null || value.id === receipt.id),
  );
  if (matches.length > 1) throw new ForgeMutationOutcome({ id: receipt.id });
  return matches[0]?.id ?? null;
}
