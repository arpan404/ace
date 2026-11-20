import type { SpadePackage } from "@ace/ui-core/spade-chat";
import { MarketResult } from "@ace/protocol/marketplace";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useOpenMarket } from "@/lib/open-market.ts";
import { pillButton } from "./spade-profile-parts.tsx";
import { TemplateUpdateDialog } from "./spade-template-update.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/*
 * A bot linked to an agent package (ADR 0200 §3.9), as one sentence above its task with its text
 * buttons, as a move is: the package and version it came from; Update when the Marketplace has a
 * newer one; Roll back to the version it had before; and, when its version was withdrawn, that it
 * is paused and why; an update accepted while it works waits for its turn to end, and says so.
 * Updating and rolling back each open their review in the Marketplace: nothing
 * changes without the person reading it first. A bot made from one of ace's templates updates
 * from the Spade it runs on, which ships the template: its review opens here.
 */

/** What the Marketplace on this machine says of the bot's install: a newer version, if any. */
function useMarketUpdate(bot: RosterBot, on: boolean): string | undefined {
  const installed = useDaemonQuery({
    queryKey: ["spade", "package-installed"],
    enabled: on,
    staleTime: 15_000,
    retry: false,
    read: async (client, signal) => {
      const answer = await client.request(
        { type: "marketplace.request", operation: { op: "installed" } },
        { signal },
      );
      const result = MarketResult.safeParse(answer.result);
      return result.success && result.data.op === "installed" ? result.data.installed : [];
    },
  });
  return installed.data?.find(
    (item) => item.type === "spade-bot" && item.target === bot.id && item.linked,
  )?.update;
}

/** Where the package is in the Marketplace's address: `bot/flight-watcher`. */
const marketAt = (link: SpadePackage) =>
  `bot/${link.name}${link.source === "market" ? "" : `@${link.source}`}`;

/**
 * "From flight-watcher 1.0.0 in the Marketplace.", and when an update waits for the bot to be
 * still: "Updates when Flight watcher is done with its turn."
 */
export function packageSentence(link: SpadePackage, bot: string): string {
  const from = `${link.name} ${link.version}`;
  if (link.withdrawn) return `Paused: ${from} was withdrawn. ${link.withdrawn}`;
  if (link.updating) return `Updating from ${from} to ${link.updating}.`;
  const held = link.held ? ` Updates when ${bot} is done with its turn.` : "";
  if (link.source === "spade") return `From ace's ${link.name} template ${link.version}.${held}`;
  const where = link.source === "market" ? "the Marketplace" : "a catalog you added";
  return `From ${from} in ${where}.${held}`;
}

export function ProfilePackageLine(props: { bot: RosterBot }) {
  const { bot } = props;
  const link = bot.package;
  const market = useBetaEnabled("marketplace") === true;
  // Updates come from the Marketplace of the machine the bot runs on.
  const here = market && bot.machine.primary && link !== undefined;
  const update = useMarketUpdate(bot, here);
  const open = useOpenMarket();
  if (!link) return null;
  if (link.source === "spade") return <TemplateLine bot={bot} link={link} />;
  const at = marketAt(link);
  return (
    <div role="status" className="flex flex-col gap-1 pb-3">
      <p className="text-ui leading-5 text-foreground">{packageSentence(link, bot.name)}</p>
      {here && !link.updating && !link.held && (update || link.previous || link.withdrawn) && (
        <div className="-ml-3.5 flex flex-wrap items-center gap-1">
          {update && !link.withdrawn && (
            <Button variant="ghost" className={pillButton} onClick={() => open(`${at}/update`)}>
              Update to {update}
            </Button>
          )}
          {link.previous && (
            <Button variant="ghost" className={pillButton} onClick={() => open(`${at}/rollback`)}>
              Roll back to {link.previous}
            </Button>
          )}
          {link.withdrawn && (
            <Button variant="ghost" className={pillButton} onClick={() => open("installed")}>
              Resume in the Marketplace
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A bot from one of ace's templates: Update when the Spade it runs on ships a newer version of
 * it, opening that update's review. Its earlier versions aren't kept, so there is no Roll back.
 */
function TemplateLine(props: { bot: RosterBot; link: SpadePackage }) {
  const { bot, link } = props;
  const [reviewing, setReviewing] = useState(false);
  const offered = link.templateUpdate;
  const still = !link.updating && !link.held && !link.withdrawn;
  return (
    <div role="status" className="flex flex-col gap-1 pb-3">
      <p className="text-ui leading-5 text-foreground">{packageSentence(link, bot.name)}</p>
      {offered && still && (
        <div className="-ml-3.5 flex flex-wrap items-center gap-1">
          <Button variant="ghost" className={pillButton} onClick={() => setReviewing(true)}>
            Update to {offered}
          </Button>
          <TemplateUpdateDialog
            bot={bot}
            version={offered}
            open={reviewing}
            onClose={() => setReviewing(false)}
          />
        </div>
      )}
    </div>
  );
}
