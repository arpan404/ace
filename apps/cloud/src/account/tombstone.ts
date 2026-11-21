/**
 * The SQL guard that refuses a write for an account that is being or has been deleted (a row in
 * `account_deletions`), with `param` the placeholder its account id binds to. Session, machine and enrollment writes check
 * it as they write, so a sign-in or relay grant issued before a deletion can't put the
 * account's rows back.
 */
export const notDeleted = (param = "?") =>
  `NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id = ${param})`;

/** Whether the account has a deletion recorded, begun or finished. */
export async function accountDeleted(db: D1Database, accountId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS deleted FROM account_deletions WHERE account_id = ?")
    .bind(accountId)
    .first();
  return row !== null;
}
