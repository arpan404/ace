import { z } from "zod";
import { ForgeCheck } from "@ace/protocol/forge";
import type { CommandRunner } from "./command.ts";
import { teaGet } from "./tea-api.ts";
import { decode, sha } from "./tea-records.ts";
import { ForgeError } from "./errors.ts";
import { clipText } from "./host-text.ts";
const record = z.looseObject({
  id: z.number().int().positive(),
  context: z.string(),
  status: z.string(),
  updated_at: z.string().optional(),
});
const combined = z.looseObject({
  sha,
  state: z.string(),
  total_count: z.number().int().nonnegative(),
  statuses: z.array(record).max(100),
});

/** Read every page for an immutable commit; the host aggregate can only make CI stricter. */
export async function teaChecks(
  runner: CommandRunner,
  login: string,
  root: string,
  head: string,
  signal: AbortSignal,
) {
  decode(sha, head);
  const latest = new Map<string, z.infer<typeof record>>();
  let total: number | undefined;
  let seen = 0;
  let aggregate = "success";
  for (let page = 1; page <= 20; page++) {
    const response = decode(
      combined,
      (await teaGet(runner, login, `${root}/commits/${head}/status?page=${page}&limit=100`, signal))
        .body,
    );
    if (response.sha !== head) throw new ForgeError("head_moved");
    if (total !== undefined && total !== response.total_count) throw new ForgeError("conflict");
    total = response.total_count;
    if (response.state !== "success") aggregate = response.state;
    seen += response.statuses.length;
    for (const s of response.statuses)
      if (s.id > (latest.get(s.context)?.id ?? 0)) latest.set(s.context, s);
    if (seen < total) {
      if (!response.statuses.length) throw new ForgeError("invalid_data");
      continue;
    }
    const checks = [...latest.values()].map((s) =>
      decode(ForgeCheck, {
        id: String(s.id),
        name: clipText(s.context),
        status:
          s.status === "success"
            ? "success"
            : s.status === "pending"
              ? "pending"
              : s.status === "failure" || s.status === "error"
                ? "failure"
                : "unknown",
        conclusion: s.status,
        completedAt:
          s.status === "success" || s.status === "failure" || s.status === "error"
            ? (s.updated_at ?? null)
            : null,
        jobId: null,
        url: null,
      }),
    );
    const ci: "none" | "pending" | "success" | "failure" | "unknown" =
      aggregate === "pending" || checks.some((c) => c.status === "pending")
        ? "pending"
        : !["success", "failure", "error"].includes(aggregate) ||
            checks.some((c) => c.status === "unknown")
          ? "unknown"
          : aggregate === "failure" ||
              aggregate === "error" ||
              checks.some((c) => c.status === "failure")
            ? "failure"
            : checks.length
              ? "success"
              : "none";
    return { checks, ci };
  }
  throw new ForgeError("limit");
}
