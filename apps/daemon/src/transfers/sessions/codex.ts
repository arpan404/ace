import { codexPlan, MigrationFailure } from "@ace/accounts/session-files";
import { SessionNotCarried, type SessionCarrier } from "./carrier.ts";
import { bounded } from "./claude.ts";
import { placeFiles } from "./place.ts";
import { codexCwd, rewriteSession } from "./rewrite.ts";

/**
 * Codex keeps a session as a rollout, `sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl`,
 * found by id wherever it sits, with the rollouts it forks from. The copy keeps its place; its
 * header's and each turn's `cwd` move to the target's checkout. A copied rollout continues as a
 * fork from its end, as an account copy does (ADR 0018).
 */
export const codexCarrier: SessionCarrier = {
  provider: "codex",
  async capture({ home, nativeSessionId }) {
    let plan: Awaited<ReturnType<typeof codexPlan>>;
    try {
      plan = await codexPlan(home, nativeSessionId);
    } catch (error) {
      throw new SessionNotCarried(
        error instanceof MigrationFailure ? error.message : "Codex's session couldn't be read",
      );
    }
    return { nativeSessionId, files: await bounded(plan.files) };
  },
  async place({ home, staged, session, targetCwd }) {
    await placeFiles({
      home,
      staged,
      files: session.files.map((from) => ({ from, to: from })),
      rewrite: (text) => rewriteSession(text, session.sourceCwd, targetCwd, codexCwd),
    });
    return { nativeSessionId: session.nativeSessionId, action: "fork" };
  },
};
