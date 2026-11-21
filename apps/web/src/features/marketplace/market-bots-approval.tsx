import type { MarketInstalled } from "@ace/protocol/marketplace";
import { isStandingRefusal } from "@/boot/person-standing.ts";
import { ConfirmPerson } from "@/features/ace-account/index.ts";
import { Button } from "@/components/ui/button.tsx";
import { useTurnOnForBots } from "./market-api.ts";
import { failureSentence, MarketFailure } from "./market-model.ts";

/** Whether `item` is a Spade skill installed but not yet on for the person's bots. */
export function waitsForBots(item: MarketInstalled | undefined): item is MarketInstalled {
  return item?.type === "spade-skill" && item.botsApproved === false;
}

/**
 * "Installed · Turn on for your bots": a skill installed or updated by a caller without the
 * person's standing reaches no bot until the person turns this version on (ADR 0178 §12.8).
 */
export function BotsApproval(props: { item: MarketInstalled }) {
  const turnOn = useTurnOnForBots();
  const { item } = props;
  const run = () => turnOn.mutate({ name: item.name, hash: item.hash });
  const needsPerson =
    turnOn.error instanceof MarketFailure && isStandingRefusal(turnOn.error.detail);
  return (
    <span className="mk-meta">
      Installed ·{" "}
      <Button size="sm" variant="ghost" disabled={turnOn.isPending} onClick={run}>
        Turn on for your bots
      </Button>
      {needsPerson ? (
        <ConfirmPerson onConfirmed={run} />
      ) : (
        turnOn.error && (
          <span className="mk-withdrawn-line">{failureSentence(turnOn.error, "install")}</span>
        )
      )}
    </span>
  );
}
