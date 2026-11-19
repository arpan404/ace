import type { MarketVerificationProof, MarketVerificationStatus } from "@ace/protocol/marketplace";
import { proofsOf, type PublisherTable } from "./profiles.ts";

/*
 * Publisher verification in D1 (ADR 0174 §13): proof tokens (random, single use, 48 hours),
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
    .prepare(
      `SELECT * FROM verification_challenges WHERE publisher = ?1 AND kind IN ('domain', 'github')
        ORDER BY kind`,
    )
    .bind(publisher)
    .all<ChallengeTable>();
  return results;
}

/** The proof field that names a challenge's subject: `$.domain` or `$.login`. */
const subjectPath = "CASE ?2 WHEN 'domain' THEN '$.domain' ELSE '$.login' END";

/**
 * Whether a challenge's subject is one of the proofs the publisher's mark was granted on: the
 * signed verified list stores those as the publisher's `approved_proofs` (ADR 0174 §13).
 */
const approvedSubject = (subject: string) =>
  `EXISTS (SELECT 1 FROM publishers p, json_each(p.approved_proofs) j WHERE p.id = ?1
    AND p.verified = 1
    AND json_extract(j.value, '$.kind') = ?2
    AND json_extract(j.value, ${subjectPath}) = ${subject})`;

/**
 * A new token for a claim, replacing any earlier one of the same kind. A verified publisher's
 * passed challenge on an approved proof is kept aside as `<kind>:approved` first, so the weekly
 * re-check still has the token the mark was granted on.
 */
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
  const keep = `EXISTS (SELECT 1 FROM verification_challenges c WHERE c.publisher = ?1
    AND c.kind = ?2 AND c.state = 'passed' AND ${approvedSubject("c.subject")})`;
  await db.batch([
    db
      .prepare(
        `DELETE FROM verification_challenges WHERE publisher = ?1 AND kind = ?2 || ':approved'
          AND ${keep}`,
      )
      .bind(input.publisher, input.kind),
    db
      .prepare(
        `UPDATE verification_challenges SET kind = kind || ':approved'
          WHERE publisher = ?1 AND kind = ?2 AND state = 'passed'
          AND ${approvedSubject("verification_challenges.subject")}`,
      )
      .bind(input.publisher, input.kind),
    db
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
      ),
  ]);
}

/**
 * Records a check's outcome. A pass spends the token (only a waiting or failed one may pass) and,
 * in the same batch, merges the proof into the application's proofs, with the account proof
 * every applicant has; the publisher then waits for a maintainer. A verified publisher applies
 * the same way: its approved proofs (`approved_proofs`) stay as they are, so the mark and its
 * re-checks keep to them, while the queue shows the application with the new proof.
 */
export async function recordCheck(
  db: D1Database,
  publisher: string,
  challenge: { token: string },
  outcome: { passed: MarketVerificationProof } | { problem: string },
  now: number,
): Promise<void> {
  if ("problem" in outcome) {
    await db
      .prepare(
        `UPDATE verification_challenges SET state = 'failed', problem = ?3
          WHERE publisher = ?1 AND token = ?2 AND state != 'passed'`,
      )
      .bind(publisher, challenge.token, outcome.problem.slice(0, 500))
      .run();
    return;
  }
  await db.batch([
    db
      .prepare(
        `UPDATE verification_challenges SET state = 'passed', problem = NULL
          WHERE publisher = ?1 AND token = ?2 AND state != 'passed' AND expires > ?3`,
      )
      .bind(publisher, challenge.token, now),
    db
      .prepare(
        `UPDATE publishers SET verification_at = ?3, verification = 'applied',
          proofs = (SELECT json_group_array(json(value)) FROM (
            SELECT '{"kind":"account"}' AS value, 0 AS rank, 0 AS position
            UNION ALL SELECT value, 1, key FROM json_each(publishers.proofs)
              WHERE json_extract(value, '$.kind') NOT IN ('account', ?4)
            UNION ALL SELECT ?5, 2, 0
            ORDER BY rank, position LIMIT 8))
          WHERE id = ?1 AND EXISTS (SELECT 1 FROM verification_challenges
            WHERE publisher = ?1 AND token = ?2 AND state = 'passed')`,
      )
      .bind(publisher, challenge.token, now, outcome.passed.kind, JSON.stringify(outcome.passed)),
  ]);
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

/**
 * Verified publishers due a weekly re-check of their approved domain proof, a bounded batch: the
 * passed challenge on the domain the mark was granted on, the newer one when the publisher
 * proved that domain again, else the one kept aside when they applied again.
 */
export async function dueRechecks(
  db: D1Database,
  now: number,
  limit = 20,
): Promise<{ publisher: string; domain: string; token: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT c.publisher, c.subject AS domain, c.token FROM verification_challenges c
        JOIN publishers p ON p.id = c.publisher
        WHERE p.verified = 1 AND p.rechecked < ?1 AND c.state = 'passed'
        AND c.kind IN ('domain', 'domain:approved')
        AND EXISTS (SELECT 1 FROM json_each(p.approved_proofs)
          WHERE json_extract(value, '$.kind') = 'domain' AND json_extract(value, '$.domain') = c.subject)
        AND NOT (c.kind = 'domain:approved' AND EXISTS (SELECT 1 FROM verification_challenges n
          WHERE n.publisher = c.publisher AND n.kind = 'domain' AND n.state = 'passed'
          AND n.subject = c.subject))
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
