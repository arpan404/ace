import { z } from "zod";
import type { ForgeRepository, LinkedPullRequest } from "@ace/protocol/forge";
import type { GhApi } from "./http.ts";
import { ForgeError } from "./errors.ts";

const pr = z.object({
  number: z.number().int().positive(),
  title: z.string().max(65_536),
  url: z.url().max(4096),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  updatedAt: z.iso.datetime(),
  // Read leniently: a missing or unexpected head or rollup never fails the batch.
  headRefOid: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional()
    .catch(undefined),
  commits: z
    .object({
      nodes: z.array(
        z.object({
          commit: z.object({
            statusCheckRollup: z.object({ state: z.string() }).nullable().optional(),
          }),
        }),
      ),
    })
    .optional()
    .catch(undefined),
});

const Numbers = z.array(z.number().int().positive()).max(100);
const StatesBody = z.object({
  data: z.object({ repository: z.record(z.string(), pr.nullable()).nullable() }),
  errors: z.array(z.looseObject({ type: z.string().optional(), path: z.unknown() })).optional(),
});
const ErrorPath = z.tuple([z.literal("repository"), z.string()]);

const checksField = (value: z.infer<typeof pr>) => {
  const checks = checksOf(value);
  return checks ? { checks } : {};
};

/** The head commit's checks rolled up: still running, all passed, or any failed. */
function checksOf(value: z.infer<typeof pr>): LinkedPullRequest["checks"] {
  const state = value.commits?.nodes[0]?.commit.statusCheckRollup?.state;
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  if (state === "SUCCESS") return "passed";
  if (state === "FAILURE" || state === "ERROR") return "failed";
  return undefined;
}
/** Aliases request only the linked numbers, across open and terminal states. */
export async function githubStates(
  api: GhApi,
  repo: ForgeRepository,
  numbers: readonly number[],
  signal: AbortSignal,
): Promise<Map<number, LinkedPullRequest | null>> {
  Numbers.parse(numbers);
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${numbers.map((number) => `pr${number}:pullRequest(number:${number}){number title url state isDraft updatedAt headRefOid commits(last:1){nodes{commit{statusCheckRollup{state}}}}}`).join(" ")}}}`;
  const response = await api.request("graphql", signal, {
    query,
    variables: { owner: repo.owner, name: repo.name },
  });
  const parsed = StatesBody.safeParse(response.body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const aliases = new Set(numbers.map((number) => `pr${number}`));
  // GitHub answers a deleted or inaccessible number with a null alias and a NOT_FOUND error
  // naming it. That marks only that PR missing; any other error fails the whole batch.
  const missingOnly = (parsed.data.errors ?? []).every((error) => {
    const path = ErrorPath.safeParse(error.path);
    return error.type === "NOT_FOUND" && path.success && aliases.has(path.data[1]);
  });
  if (!missingOnly || !parsed.data.data.repository) throw new ForgeError("forbidden");
  const result = new Map<number, LinkedPullRequest | null>();
  for (const number of numbers) {
    const value = parsed.data.data.repository[`pr${number}`];
    if (value === undefined || (value && value.number !== number))
      throw new ForgeError("invalid_data");
    result.set(
      number,
      value
        ? {
            number,
            repo,
            url: value.url,
            title: value.title,
            state:
              value.state === "OPEN"
                ? value.isDraft
                  ? "draft"
                  : "open"
                : value.state === "MERGED"
                  ? "merged"
                  : "closed",
            updatedAt: Date.parse(value.updatedAt),
            ...(value.headRefOid ? { head: value.headRefOid } : {}),
            ...checksField(value),
          }
        : null,
    );
  }
  return result;
}
