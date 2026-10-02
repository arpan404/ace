import { z } from "zod";
import { ForgeCreatePrInput, ForgeThreadLink } from "@ace/protocol/forge";
import type { Forge } from "./api.ts";
import type { ForgeStore } from "./store.ts";
import { ForgeError } from "./errors.ts";

const inputs = {
  forge_pr_status: z.strictObject({ number: z.number().int().positive() }),
  forge_create_pr: ForgeCreatePrInput,
  forge_link_pr: z.strictObject({ number: z.number().int().positive() }),
  forge_reply_comment: z.strictObject({
    number: z.number().int().positive(),
    commentId: z.number().int().positive(),
    body: z.string().min(1).max(65_536),
  }),
};
const descriptions = {
  forge_pr_status: "Read PR state, checks, CI and review comments in this thread's repository.",
  forge_create_pr: "Create and link a PR from this thread's branch using a title/body template.",
  forge_link_pr: "Validate and persist a PR link for this thread.",
  forge_reply_comment: "Reply to an inline review comment on the linked PR.",
};
export const forgeMcpTools = Object.entries(inputs).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof descriptions],
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
}));
/** Server supplies trusted scope after auth. Client arguments never select it. */
export function createForgeToolkit(options: {
  forge: Forge;
  store: ForgeStore;
  threadId: string;
  branch: string;
}) {
  const scope = z
    .object({ threadId: z.string().min(1).max(256), branch: z.string().min(1).max(256) })
    .parse(options);
  return {
    tools: forgeMcpTools,
    async call(name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
      try {
        if (name === "forge_create_pr") {
          const input = inputs.forge_create_pr.parse(args);
          if (input.branch !== scope.branch) throw new ForgeError("forbidden");
          const pr = await options.forge.createPr(scope.threadId, input, signal);
          const link = ForgeThreadLink.parse({ threadId: scope.threadId, pr });
          options.store.link(link);
          return link;
        }
        if (name === "forge_link_pr") {
          const { number } = inputs.forge_link_pr.parse(args);
          const status = await options.forge.status(number, signal);
          const link = ForgeThreadLink.parse({ threadId: scope.threadId, pr: status.ref });
          options.store.link(link);
          return link;
        }
        if (name === "forge_pr_status" || name === "forge_reply_comment") {
          const link = options.store.getLink(scope.threadId);
          const { number } = inputs.forge_pr_status.parse(
            name === "forge_reply_comment"
              ? { number: z.object({ number: z.number() }).parse(args).number }
              : args,
          );
          if (
            !link ||
            link.pr.number !== number ||
            JSON.stringify(link.pr.repository) !== JSON.stringify(options.forge.repository)
          )
            throw new ForgeError("forbidden");
          if (name === "forge_pr_status") return await options.forge.status(number, signal);
          const input = inputs.forge_reply_comment.parse(args);
          await options.forge.replyComment(number, input.commentId, input.body, signal);
          return { ok: true };
        }
        throw new ForgeError("unsupported");
      } catch (error) {
        if (error instanceof ForgeError) throw error;
        throw new ForgeError("invalid_data");
      }
    },
  };
}
