import { PackagePlan } from "@ace/protocol/marketplace";
import { parseSpadePackage } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { updateSentences } from "@/features/marketplace/index.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";
import { Refusal } from "./spade-settings-rows.tsx";
import { agentsKey, type RosterBot } from "./use-spade-roster.ts";

/*
 * The update review of a bot made from one of ace's templates (ADR 0200 §3.8, §6.1), when the
 * Spade it runs on ships a newer version of that template. The same review as a Marketplace
 * update: what changes, what stays because the person or the bot changed it, and what it asks
 * for that starts off, all from Spade's own plan. Nothing changes until the person presses
 * Update, and then only to the very version they read.
 */

const Identity = z.object({
  source: z.string().max(64),
  name: z.string().max(128),
  version: z.string().max(64),
  hash: z.string().max(128),
});
const Offer = z.object({
  package: Identity,
  plan: PackagePlan,
  effects: z.array(z.unknown()).max(64).catch([]),
});
type Offer = z.infer<typeof Offer>;

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const offerPath = (bot: string) => `/v1/agents/${segment(bot)}/package`;

async function readOffer(target: SpadeTarget, bot: string, signal: AbortSignal) {
  const text = await spadeHttp(target, "GET", `${offerPath(bot)}/template`, { signal });
  const read = Offer.safeParse(jsonOf(text));
  if (!read.success) throw new Error("Spade's update didn't make sense.");
  return read.data;
}

/** The plan as the review's three lists, effect switches in the review's own words. */
function sentencesOf(offer: Offer) {
  const effects = parseSpadePackage({ ...offer.package, effects: offer.effects })?.effects ?? [];
  return updateSentences({ plan: offer.plan, asksMore: [] }, effects);
}

function Lines(props: { label: string; lines: readonly string[] }) {
  if (!props.lines.length) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-ui font-medium text-foreground">{props.label}</h3>
      <ul aria-label={props.label} className="flex flex-col gap-1 text-ui text-muted-foreground">
        {props.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

export function TemplateUpdateDialog(props: {
  bot: RosterBot;
  version: string;
  open: boolean;
  onClose(): void;
}) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const offer = useQuery({
    queryKey: ["spade", "template-update", machine, bot.id, props.version],
    enabled: props.open,
    retry: false,
    queryFn: ({ signal }) => readOffer(client, bot.id, signal),
  });
  const words = offer.data ? sentencesOf(offer.data) : undefined;
  const update = async (taken: Offer) => {
    setSaving(true);
    setRefusal(undefined);
    try {
      await spadeHttp(client, "POST", offerPath(bot.id), {
        body: { package: taken.package, transaction: `template-${crypto.randomUUID()}` },
      });
      props.onClose();
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      await cache.invalidateQueries({ queryKey: agentsKey });
      setSaving(false);
    }
  };
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update {bot.name}</DialogTitle>
          <DialogDescription>
            {offer.isError
              ? fault(offer.error)
              : `ace's ${offer.data?.package.name ?? "template"} template ${props.version} came with this Spade. Nothing changes until you update.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {words && (
            <>
              <Lines label="What changes" lines={words.changes} />
              <Lines label="Stays because you changed it" lines={words.kept} />
              <Lines label="Asks for more" lines={words.more} />
            </>
          )}
          {refusal && (
            <p className="text-xs">
              <Refusal>{refusal}</Refusal>
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Not now
          </Button>
          <Button
            variant="secondary"
            disabled={!offer.data || saving}
            onClick={() => offer.data && void update(offer.data)}
          >
            Update to {props.version}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
