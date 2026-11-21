import { PackagePlan } from "@ace/protocol/marketplace";
import {
  parseSpadePackage,
  parseSpadeReplay,
  parseSpadeReplayEstimate,
  replayOffer,
  updateSentences,
  type SpadeReplay,
} from "@ace/ui-core/spade-chat";
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
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";
import { ReplayLine } from "./spade-replay-line.tsx";
import { Refusal } from "./spade-settings-rows.tsx";
import { agentsKey, type RosterBot } from "./use-spade-roster.ts";

/*
 * The update review of a bot made from one of ace's templates (ADR 0200 §3.8, §6.1), when the
 * Spade it runs on ships a newer version of that template. The same review as a Marketplace
 * update: what changes, what stays because the person or the bot changed it, and what it asks
 * for that starts off, all from Spade's own plan, and how the bot's kept runs replay on the new
 * version (ADR 0204 §2): free as the review opens, and on the bot's own model only when the
 * person presses Try it, its cost said first. Nothing changes until the person presses Update,
 * and then only to the very version they read.
 */

const Identity = z.object({
  source: z.string().max(64),
  name: z.string().max(128),
  version: z.string().max(64),
  hash: z.string().max(128),
});
const Offer = z.object({
  package: Identity,
  recipe: z.unknown(),
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

const replayPath = (bot: string) => `/v1/agents/${segment(bot)}/cases/replay`;

/** The bot's kept runs replayed on the offered version: free, or on `model` when named. */
async function replayOn(
  target: SpadeTarget,
  bot: string,
  offer: Offer,
  model: string | undefined,
  signal?: AbortSignal,
): Promise<SpadeReplay> {
  const body = { recipe: offer.recipe, ...(model ? { model } : {}) };
  const text = await spadeHttp(target, "POST", replayPath(bot), { body, signal });
  const read = parseSpadeReplay(jsonOf(text));
  if (!read) throw new Error("Spade's replay didn't make sense.");
  return read;
}

/** The plan as the review's three lists, effect switches in the review's own words. */
function sentencesOf(offer: Offer) {
  const effects = parseSpadePackage({ ...offer.package, effects: offer.effects })?.effects ?? [];
  return updateSentences({ plan: offer.plan, asksMore: [] }, effects);
}

/** The bot's kept runs on the new version: the free replay, then the offer to try its model. */
function KeptRuns(props: { bot: string; offer: Offer; machine: string; version: string }) {
  const client = useSpadeClient();
  const key = ["spade", "template-replay", props.machine, props.bot, props.version];
  const free = useQuery({
    queryKey: key,
    retry: false,
    queryFn: ({ signal }) => replayOn(client, props.bot, props.offer, undefined, signal),
  });
  const estimate = useQuery({
    queryKey: [...key, "estimate"],
    enabled: (free.data?.cases.length ?? 0) > 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const path = `${replayPath(props.bot)}?model=current`;
      return parseSpadeReplayEstimate(jsonOf(await spadeHttp(client, "GET", path, { signal })));
    },
  });
  const [tried, setTried] = useState<{ replay?: SpadeReplay; error?: string; running?: boolean }>(
    {},
  );
  if (!free.isPending && !free.isError && (free.data?.cases.length ?? 0) === 0) return null;
  const offer = estimate.data ? replayOffer(estimate.data) : undefined;
  const tryIt = async () => {
    setTried({ running: true });
    try {
      setTried({ replay: await replayOn(client, props.bot, props.offer, "current") });
    } catch (error) {
      setTried({ error: fault(error) });
    }
  };
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-ui font-medium text-foreground">Your kept runs</h3>
      <ReplayLine
        replay={free.data}
        pending={free.isPending}
        error={free.isError ? fault(free.error) : undefined}
      />
      {offer && !tried.replay && !tried.running && (
        <div className="flex flex-wrap items-center gap-x-1">
          <p className="text-ui text-muted-foreground">{offer}</p>
          <Button variant="ghost" size="sm" onClick={() => void tryIt()}>
            Try it
          </Button>
        </div>
      )}
      {(tried.replay || tried.running || tried.error) && (
        <ReplayLine replay={tried.replay} pending={tried.running} error={tried.error} />
      )}
    </section>
  );
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
          {offer.data && (
            <KeptRuns bot={bot.id} offer={offer.data} machine={machine} version={props.version} />
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
