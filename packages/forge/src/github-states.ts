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
});
/** Aliases request only the linked numbers, across open and terminal states. */
export async function githubStates(
  api: GhApi,
  repo: ForgeRepository,
  numbers: readonly number[],
  signal: AbortSignal,
): Promise<Map<number, LinkedPullRequest | null>> {
  z.array(z.number().int().positive()).max(100).parse(numbers);
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${numbers.map((number) => `pr${number}:pullRequest(number:${number}){number title url state isDraft updatedAt}`).join(" ")}}}`;
  const response = await api.request("graphql", signal, {
    query,
    variables: { owner: repo.owner, name: repo.name },
  });
  const parsed = z
    .object({
      data: z.object({ repository: z.record(z.string(), pr.nullable()).nullable() }),
      errors: z.array(z.unknown()).optional(),
    })
    .safeParse(response.body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  if (parsed.data.errors?.length || !parsed.data.data.repository) throw new ForgeError("forbidden");
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
          }
        : null,
    );
  }
  return result;
}
