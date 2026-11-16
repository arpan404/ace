import type { MarketVerificationProof, MarketVerificationStatus } from "@ace/protocol/marketplace";
import { proofsOf, type PublisherTable } from "./profiles.ts";

/*
 * Publisher verification in D1 (ADR 0173 §13): proof tokens (random, single use, 48 hours),
 * passed proofs on the publisher, and the state maintainers act on through the signer's routes.
 */

export const tokenHours = 48;

export interface ChallengeTable {
  publisher: string;
  kind: "domain" | "github";
  subject: string;
  token: string;
  expires: number;
  state: "waiting" | "passed" | "failed";
  problem: string | null;
}

export async function challengesOf(db: D1Database, publisher: string): Promise<ChallengeTable[]> {
  const { results } = await db
    .prepare("SELECT * FROM verification_challenges WHERE publisher = ?1 ORDER BY kind")
    .bind(publisher)
    .all<ChallengeTable>();
  return results;
}

/** A new token for a claim, replacing any earlier one of the same kind. */
export async function issueChallenge(
  db: D1Database,
  input: {
    publisher: string;
    kind: "domain" | "github";
    subject: string;
    token: string;
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO verification_challenges (publisher, kind, subject, token, expires, state)
        VALUES (?1, ?2, ?3, ?4, ?5, 'waiting')
        ON CONFLICT (publisher, kind) DO UPDATE SET subject = excluded.subject,
          token = excluded.token, expires = excluded.expires, state = 'waiting', problem = NULL`,
    )
    .bind(
      input.publisher,
      input.kind,
      input.subject,
      input.token,
      input.now + tokenHours * 3_600_000,
    )
    .run();
}

/**
 * Records a check's outcome. A pass spends the token (only a waiting or failed one may pass) and
 * adds the proof, with the account proof every applicant has; the publisher then waits for a
 * maintainer unless already verified.
 */
export async function recordCheck(
  db: D1Database,
  publisher: PublisherTable,
  challenge: ChallengeTable,
  outcome: { passed: MarketVerificationProof } | { problem: string },
  now: number,
): Promise<void> {
  if ("problem" in outcome) {
    await db
      .prepare(
        `UPDATE verification_challenges SET state = 'failed', problem = ?3
          WHERE publisher = ?1 AND token = ?2 AND state != 'passed'`,
      )
      .bind(publisher.id, challenge.token, outcome.problem.slice(0, 500))
      .run();
    return;
  }
  const proofs = proofsOf(publisher).filter(
    (proof) => proof.kind !== "account" && proof.kind !== outcome.passed.kind,
  );
  const next: MarketVerificationProof[] = [{ kind: "account" }, ...proofs, outcome.passed];
  const spent = await db
    .prepare(
      `UPDATE verification_challenges SET state = 'passed', problem = NULL
        WHERE publisher = ?1 AND token = ?2 AND state != 'passed' AND expires > ?3`,
    )
    .bind(publisher.id, challenge.token, now)
    .run();
  if (spent.meta.changes !== 1) return;
  await db
    .prepare(
      `UPDATE publishers SET proofs = ?2, verification_at = ?3,
        verification = CASE WHEN verification = 'verified' THEN 'verified' ELSE 'applied' END
        WHERE id = ?1`,
    )
    .bind(publisher.id, JSON.stringify(next.slice(0, 8)), now)
    .run();
}

export function verificationStatus(
  publisher: PublisherTable,
  challenges: readonly ChallengeTable[],
): MarketVerificationStatus {
  const state = publisher.verification as MarketVerificationStatus["state"];
  return {
    verified: publisher.verified === 1,
    proofs: proofsOf(publisher),
    state,
    challenges: challenges.slice(0, 4).map((challenge) => {
      const shown: MarketVerificationStatus["challenges"][number] = {
        kind: challenge.kind,
        subject: challenge.subject,
        token: challenge.token,
        expiresAt: challenge.expires,
        state: challenge.state,
      };
      if (challenge.problem) shown.problem = challenge.problem;
      return shown;
    }),
    ...(publisher.verification_reason ? { reason: publisher.verification_reason } : {}),
    ...(publisher.verification_flag ? { flagged: publisher.verification_flag } : {}),
  };
}

/** Verified publishers due a weekly re-check of their domain proof, a bounded batch. */
export async function dueRechecks(
  db: D1Database,
  now: number,
  limit = 20,
): Promise<{ publisher: string; domain: string; token: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT c.publisher, c.subject AS domain, c.token FROM verification_challenges c
        JOIN publishers p ON p.id = c.publisher
        WHERE p.verified = 1 AND c.kind = 'domain' AND c.state = 'passed' AND p.rechecked < ?1
        ORDER BY p.rechecked LIMIT ?2`,
    )
    .bind(now - 7 * 86_400_000, limit)
    .all<{ publisher: string; domain: string; token: string }>();
  return results;
}

/** A re-check's outcome: a failure flags the mark for maintainers and never drops it. */
export async function recordRecheck(
  db: D1Database,
  publisher: string,
  problem: string | undefined,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE publishers SET rechecked = ?2,
        verification_flag = CASE WHEN ?3 IS NULL THEN verification_flag ELSE ?3 END WHERE id = ?1`,
    )
    .bind(publisher, now, problem ?? null)
    .run();
}
