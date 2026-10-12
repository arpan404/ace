import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { ForgeStackLayer } from "@ace/protocol/forge-stacks";
import type { GhApi } from "./http.ts";
import { stackPrState } from "./stack-plan.ts";
import { ForgeError } from "./errors.ts";
const positive = z.number().int().positive();
const text = z.string().max(65_536);
const facts = z.looseObject({
  number: positive,
  state: text,
  isDraft: z.boolean(),
  mergeQueueEntry: z.looseObject({ state: text }).nullable(),
});

/** Queue facts remain readable after native membership dissolves or changes. */
export async function readStackMergeScope(
  api: GhApi,
  repository: ForgeRepository,
  numbers: readonly number[],
  signal: AbortSignal,
): Promise<(Pick<ForgeStackLayer, "number" | "state" | "queueState"> & { raw: unknown })[]> {
  z.array(positive).max(100).parse(numbers);
  const unique = [...new Set(numbers)];
  if (!unique.length) return [];
  const page = await api.request("graphql", signal, {
    query: `query StackMergeScope($owner:String!,$name:String!){repository(owner:$owner,name:$name){${unique.map((number) => `pr${number}:pullRequest(number:${number}){number state isDraft mergeQueueEntry{state}}`).join(" ")}}}`,
    variables: { owner: repository.owner, name: repository.name },
  });
  const result = z
    .object({
      data: z.object({ repository: z.record(z.string(), facts.nullable()).nullable() }),
    })
    .safeParse(page.body);
  if (!result.success) throw new ForgeError("invalid_data");
  if (!result.data.data.repository) throw new ForgeError("not_found");
  return unique.map((number) => {
    const pr = result.data.data.repository?.[`pr${number}`];
    if (pr === undefined || (pr && pr.number !== number)) throw new ForgeError("invalid_data");
    if (!pr) throw new ForgeError("not_found");
    return {
      number,
      raw: pr,
      state: stackPrState(pr),
      queueState: pr.mergeQueueEntry?.state ?? null,
    };
  });
}
