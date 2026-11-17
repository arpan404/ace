import { legacy, type CommandContext, type Handlers } from "./context.ts";

/*
 * The market's handlers (ADR 0176 §11, §12): people and publishers through the daemon's
 * `marketplace.request`, the local check offline, and the maintainer tools straight to the
 * market. Modules load on use, so the table stays cheap to read.
 */

async function maintainer(context: CommandContext, verb: string): Promise<void> {
  const { maintainerCommand } = await import("../market/maintainer.ts");
  return maintainerCommand(legacy(context, ["market", verb]));
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

/** Commands that are one request, printed as their answer. */
const single = [
  "market.discover",
  "market.search",
  "market.show",
  "market.remove",
  "market.restore",
  "market.installed",
  "market.source.list",
  "market.source.add",
  "market.source.remove",
  "market.source.on",
  "market.source.off",
  "market.source.refresh",
  "market.report",
  "market.draft.list",
  "market.draft.show",
  "market.draft.delete",
  "market.status",
  "market.versions",
  "market.latest",
  "market.deprecate",
  "market.visibility",
  "market.archive",
  "market.unarchive",
  "market.withdraw",
  "market.transfer",
  "market.transfer.accept",
  "market.transfer.decline",
  "market.delete",
  "market.signals",
  "market.profile.show",
  "market.profile.create",
  "market.profile.edit",
  "market.profile.handle",
  "market.profile.pins",
  "market.verification.show",
  "market.verification.apply",
  "market.verification.check",
];

const flows = () => import("./market-flows.ts");

export const marketHandlers: Handlers = {
  "market.check": async (context) => (await import("../market/check.ts")).marketCheck(context.args),
  ...Object.fromEntries(
    single.map((id) => [id, async (context: CommandContext) => (await flows()).one(context)]),
  ),
  "market.install": async (context) => (await flows()).install(context),
  "market.update": async (context) => (await flows()).update(context),
  "market.publish": async (context) => (await flows()).publish(context),
  "market.draft.publish": async (context) => (await flows()).publishDraft(context),
  "market.draft.update": async (context) => (await flows()).withTexts(context, ["changelog"]),
  "market.changelog": async (context) => (await flows()).withTexts(context, ["TEXT", "changelog"]),
  "market.describe": async (context) => (await flows()).describe(context),
  "market.profile.avatar": async (context) => (await flows()).avatar(context),
  // During the window, `ace market appeal ID --answer …` is still the maintainer's.
  "market.appeal": async (context) =>
    context.args.flags.answer !== undefined
      ? maintainer(context, "appeal")
      : (await flows()).one(context),
  ...Object.fromEntries(
    maintainerVerbs.map((verb) => [
      `market.maintainer.${verb}`,
      (context: CommandContext) => maintainer(context, verb),
    ]),
  ),
};
