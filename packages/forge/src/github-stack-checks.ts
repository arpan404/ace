import { z } from "zod";
import type { ForgeStackLayer } from "@ace/protocol/forge-stacks";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { GhApi } from "./http.ts";
import { ForgeError } from "./errors.ts";
import { ReadBudget } from "./read-budget.ts";

/** First page per layer stays small; later pages read as much as GitHub allows at once. */
const FIRST_PAGE = 20;
const NEXT_PAGE = 100;
/** Follow-up requests per snapshot. Each one pages every layer that still has contexts. */
const MAX_FOLLOW_UPS = 8;
/** The protocol's bound on the required checks reported for one layer. */
const MAX_REQUIRED = 100;

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
                  nodes: z.array(context.nullable()).max(NEXT_PAGE),
                  pageInfo: z.object({
                    hasNextPage: z.boolean(),
                    endCursor: z.string().max(1024).nullable().optional(),
                  }),
                }),
              })
              .nullable(),
          })
          .nullable(),
      )
      .nullable(),
  }),
});
type Context = z.infer<typeof context>;

interface Progress {
  layer: ForgeStackLayer;
  required: { name: string; state: string }[];
  /** Cursor of the next page, or undefined once every context was read. */
  after: string | undefined;
  /** GitHub reported more contexts that cannot be read: no cursor, or a full required list. */
  truncated: boolean;
}

function contextsFields(number: number, page: number, cursor?: string) {
  const after = cursor === undefined ? "" : `,after:$c${number}`;
  return `pr${number}:pullRequest(number:${number}){headRefOid statusCheckRollup{contexts(first:${page}${after}){pageInfo{hasNextPage endCursor} nodes{kind:__typename ... on CheckRun{name status conclusion isRequired(pullRequestNumber:${number})} ... on StatusContext{context state isRequired(pullRequestNumber:${number})}}}}}`;
}

function required(check: Context | null): { name: string; state: string }[] {
  if (!check?.isRequired) return [];
  const name = check.kind === "CheckRun" ? check.name : check.context;
  const state = check.kind === "CheckRun" ? (check.conclusion ?? check.status) : check.state;
  return name ? [{ name, state: state ?? "Unknown" }] : [];
}

/**
 * Each requirement is evaluated for its own PR, rather than the selected layer. Every check
 * context is paged in, so a required check past the first page is never hidden; truncation is
 * reported only when the request or byte budget runs out first.
 */
export async function readStackChecks(
  api: GhApi,
  repository: ForgeRepository,
  layers: ForgeStackLayer[],
  signal: AbortSignal,
): Promise<{ layers: ForgeStackLayer[]; raw: unknown }> {
  const budget = new ReadBudget();
  const raw: unknown[] = [];
  const progress = layers.map((layer): Progress => ({
    layer,
    required: [],
    after: undefined,
    truncated: false,
  }));
  const read = async (pending: Progress[], first: boolean) => {
    const variables: Record<string, string> = { owner: repository.owner, name: repository.name };
    const declared = ["$owner:String!", "$name:String!"];
    const fields = pending.map(({ layer, after }) => {
      if (after === undefined) return contextsFields(layer.number, FIRST_PAGE);
      variables[`c${layer.number}`] = after;
      declared.push(`$c${layer.number}:String!`);
      return contextsFields(layer.number, NEXT_PAGE, after);
    });
    const page = await api.request("graphql", signal, {
      query: `query StackChecks(${declared.join(",")}){repository(owner:$owner,name:$name){${fields.join(" ")}}}`,
      variables,
    });
    raw.push(page.body);
    const parsed = response.safeParse(page.body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    if (!parsed.data.data.repository) throw new ForgeError("not_found");
    for (const entry of pending) {
      const pr = parsed.data.data.repository[`pr${entry.layer.number}`];
      if (!pr) throw new ForgeError("not_found");
      // A head that moves between pages would mix two commits' checks.
      if (pr.headRefOid !== entry.layer.headSha) throw new ForgeError("conflict");
      const contexts = pr.statusCheckRollup?.contexts;
      if (first && contexts && contexts.nodes.length > FIRST_PAGE)
        throw new ForgeError("invalid_data");
      for (const check of contexts?.nodes ?? []) entry.required.push(...required(check));
      const next = contexts?.pageInfo.hasNextPage ? contexts.pageInfo.endCursor : undefined;
      entry.after = next ?? undefined;
      if (contexts?.pageInfo.hasNextPage && !next) entry.truncated = true;
      if (entry.required.length > MAX_REQUIRED) {
        entry.required.length = MAX_REQUIRED;
        entry.truncated = true;
        entry.after = undefined;
      }
    }
    // Over the byte budget: what was read stays, the rest is reported as truncated.
    return budget.spend(page.bytes);
  };
  let withinBudget = await read(progress, true);
  for (let request = 0; withinBudget && request < MAX_FOLLOW_UPS; request++) {
    const pending = progress.filter((entry) => entry.after !== undefined);
    if (!pending.length) break;
    withinBudget = await read(pending, false);
  }
  const checked: ForgeStackLayer[] = [];
  for (const { layer, required: requiredChecks, after, truncated } of progress)
    checked.push({ ...layer, requiredChecks, checksTruncated: truncated || after !== undefined });
  return { raw, layers: checked };
}
