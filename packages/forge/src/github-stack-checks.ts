import { z } from "zod";
import type { ForgeStackLayer } from "@ace/protocol/forge-stacks";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { GhApi } from "./http.ts";
import { ForgeError } from "./errors.ts";

const text = z.string().max(65_536);
const context = z.looseObject({
  kind: text,
  name: text.optional(),
  context: text.optional(),
  status: text.optional(),
  conclusion: text.nullable().optional(),
  state: text.optional(),
  isRequired: z.boolean().optional(),
});
const response = z.object({
  data: z.object({
    repository: z
      .record(
        z.string(),
        z
          .looseObject({
            headRefOid: z.string(),
            statusCheckRollup: z
              .looseObject({
                contexts: z.object({
                  nodes: z.array(context.nullable()).max(20),
                  pageInfo: z.object({ hasNextPage: z.boolean() }),
                }),
              })
              .nullable(),
          })
          .nullable(),
      )
      .nullable(),
  }),
});

/** Each requirement is evaluated for its own PR, rather than the selected layer. */
export async function readStackChecks(
  api: GhApi,
  repository: ForgeRepository,
  layers: ForgeStackLayer[],
  signal: AbortSignal,
): Promise<{ layers: ForgeStackLayer[]; raw: unknown }> {
  const fields = layers.map(
    (layer) =>
      `pr${layer.number}:pullRequest(number:${layer.number}){headRefOid statusCheckRollup{contexts(first:20){pageInfo{hasNextPage} nodes{kind:__typename ... on CheckRun{name status conclusion isRequired(pullRequestNumber:${layer.number})} ... on StatusContext{context state isRequired(pullRequestNumber:${layer.number})}}}}}`,
  );
  const page = await api.request("graphql", signal, {
    query: `query StackChecks($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields.join(" ")}}}`,
    variables: { owner: repository.owner, name: repository.name },
  });
  const parsed = response.safeParse(page.body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  if (!parsed.data.data.repository) throw new ForgeError("not_found");
  return {
    raw: page.body,
    layers: layers.map((layer) => {
      const pr = parsed.data.data.repository?.[`pr${layer.number}`];
      if (!pr) throw new ForgeError("not_found");
      if (pr.headRefOid !== layer.headSha) throw new ForgeError("conflict");
      const contexts = pr.statusCheckRollup?.contexts;
      const requiredChecks = (contexts?.nodes ?? []).flatMap((check) => {
        if (!check?.isRequired) return [];
        const name = check.kind === "CheckRun" ? check.name : check.context;
        const state = check.kind === "CheckRun" ? (check.conclusion ?? check.status) : check.state;
        return name ? [{ name, state: state ?? "Unknown" }] : [];
      });
      return { ...layer, requiredChecks, checksTruncated: contexts?.pageInfo.hasNextPage ?? false };
    }),
  };
}
