import { legacy, type CommandContext, type Handlers } from "./context.ts";

/** The market: local checks, and the maintainer tools (ADR 0176 §11, §12). */
async function maintainer(context: CommandContext, verb: string): Promise<void> {
  return (await import("../market.ts")).marketCommand(legacy(context, ["market", verb]));
}

const maintainerVerbs = [
  "keygen",
  "sign",
  "review",
  "feature",
  "revoke",
  "reports",
  "collection",
  "publisher",
  "block",
  "block-file",
  "block-pattern",
  "appeals",
  "appeal",
  "verify",
  "unverify",
  "official",
];

export const marketHandlers: Handlers = {
  "market.check": async (context) => {
    const words = context.args.words.length ? context.args.words : ["."];
    const args = { ...context.args, words: ["marketplace", "check", ...words] };
    return (await import("../market.ts")).marketplaceCommand(args);
  },
  ...Object.fromEntries(
    maintainerVerbs.map((verb) => [
      `market.maintainer.${verb}`,
      (context: CommandContext) => maintainer(context, verb),
    ]),
  ),
};
