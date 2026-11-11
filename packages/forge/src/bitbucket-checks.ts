import { z } from "zod";
import { ForgeCheck } from "@ace/protocol/forge";
import type { CommandRunner } from "./command.ts";
import { bktGet, nextEndpoint } from "./bkt-api.ts";
import { decode, page, sha } from "./bitbucket-records.ts";
import { ForgeError } from "./errors.ts";
import { clipText } from "./host-text.ts";

const status = z.looseObject({
  key: z.string(),
  name: z.string().nullable().optional(),
  state: z.string(),
  url: z.string().nullable().optional(),
  updated_on: z.string().nullable().optional(),
  links: z.looseObject({ commit: z.looseObject({ href: z.string() }).optional() }).optional(),
});
const StatusPage = page(status, 100);

export type BitbucketCi = "none" | "pending" | "success" | "failure" | "unknown";

/**
 * A pull request's build statuses for its head `head` (`GET …/pullrequests/<n>/statuses`,
 * every page), as checks. A status for another commit is left out; one that names no commit
 * can't be placed and is unknown. INPROGRESS is pending, STOPPED cancelled, and any state
 * Bitbucket adds later unknown: CI is success only when every status succeeded.
 */
export async function bitbucketChecks(
  runner: CommandRunner,
  context: string,
  root: string,
  number: number,
  head: string,
  signal: AbortSignal,
) {
  decode(sha, head);
  const raw: unknown[] = [];
  const statuses: z.infer<typeof status>[] = [];
  let endpoint: string | undefined = `${root}/pullrequests/${number}/statuses?pagelen=100`;
  for (let index = 0; endpoint !== undefined; index++) {
    if (index === 20) throw new ForgeError("limit");
    const body = await bktGet(runner, context, endpoint, signal);
    const data = decode(StatusPage, body);
    raw.push(body);
    statuses.push(...data.values);
    endpoint = nextEndpoint(data.next, endpoint);
  }
  const checks: ForgeCheck[] = [];
  for (const s of statuses) {
    const commit = s.links?.commit?.href;
    if (commit !== undefined && !commit.endsWith(`/commit/${head}`)) continue;
    const mapped =
      commit === undefined
        ? "unknown"
        : s.state === "SUCCESSFUL"
          ? "success"
          : s.state === "INPROGRESS"
            ? "pending"
            : s.state === "FAILED"
              ? "failure"
              : s.state === "STOPPED"
                ? "cancelled"
                : "unknown";
    const done = mapped === "success" || mapped === "failure" || mapped === "cancelled";
    checks.push(
      decode(ForgeCheck, {
        id: clipText(s.key).slice(0, 256),
        name: clipText(s.name || s.key),
        status: mapped,
        conclusion: s.state.slice(0, 100),
        completedAt: done ? (s.updated_on ?? null) : null,
        jobId: null,
        url: s.url && /^https:\/\//.test(s.url) ? clipText(s.url) : null,
      }),
    );
  }
  const ci: BitbucketCi = checks.some((c) => c.status === "pending")
    ? "pending"
    : checks.some((c) => c.status === "unknown")
      ? "unknown"
      : checks.some((c) => c.status === "failure" || c.status === "cancelled")
        ? "failure"
        : checks.length
          ? "success"
          : "none";
  return { checks, ci, raw };
}
