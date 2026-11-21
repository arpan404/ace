import { codexPlan, MigrationFailure } from "@ace/accounts/session-files";
import { SessionNotCarried, type SessionCarrier } from "./carrier.ts";
import { bounded } from "./claude.ts";
import { placeFiles } from "./place.ts";
import { codexCwd, renameSession, rewriteSession } from "./rewrite.ts";

/**
 * Codex keeps a session as a rollout, `sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl`,
 * found by id wherever it sits, with the rollouts it forks from. The copy keeps its place; its
 * header's and each turn's `cwd` move to the target's checkout. Each rollout takes a fresh id, in
 * its name and its header, and the ids a rollout forks from follow, so the lineage holds. A copied
 * rollout continues as a fork from its end, as an account copy does (ADR 0018).
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
  async place({ home, staged, session, targetCwd, newId }) {
    const ids = new Map<string, string>();
    for (const file of session.files) {
      const id = rolloutId(file);
      if (!id) throw new SessionNotCarried("A Codex session file isn't named after its rollout");
      if (!ids.has(id)) ids.set(id, newId());
    }
    const root = ids.get(session.nativeSessionId.toLowerCase());
    if (!root) throw new SessionNotCarried("The Codex session's own rollout wasn't carried");
    await placeFiles({
      home,
      staged,
      files: session.files.map((from) => ({ from, to: renamed(from, ids) })),
      rewrite: (text) =>
        renameSession(rewriteSession(text, session.sourceCwd, targetCwd, codexCwd), ids),
    });
    return { nativeSessionId: root, action: "fork" };
  },
};

/** A rollout's name ends in its id: `rollout-<time>-<id>.jsonl`. */
const rolloutName =
  /^(rollout-.*-)([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(\.jsonl)$/i;

function rolloutId(relative: string): string | undefined {
  return (relative.split("/").pop() ?? "").match(rolloutName)?.[2]?.toLowerCase();
}

/** The same place, the name ending in the rollout's fresh id. */
function renamed(relative: string, ids: ReadonlyMap<string, string>): string {
  const parts = relative.split("/");
  const match = (parts.pop() ?? "").match(rolloutName);
  const fresh = match?.[2] ? ids.get(match[2].toLowerCase()) : undefined;
  if (!match || !fresh)
    throw new SessionNotCarried("A Codex session file isn't named after its rollout");
  return [...parts, `${match[1]}${fresh}${match[3]}`].join("/");
}
