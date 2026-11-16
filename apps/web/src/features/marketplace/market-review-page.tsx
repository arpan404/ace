import { useClient } from "@ace/client-react";
import type { MarketReview } from "@ace/protocol/marketplace";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { readAgents } from "@/features/spade/index.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import {
  useCancelReview,
  useInstall,
  useMarketEntry,
  useMarketReview,
  type EntryKey,
  type PreparedReview,
} from "./market-api.ts";
import {
  RecipeFacts,
  ReviewItems,
  RoutineRows,
  SuitLook,
  suitFromReview,
} from "./market-facts.tsx";
import {
  byline,
  canDoSentences,
  failureSentence,
  installBlock,
  needDefaults,
  typeWord,
} from "./market-model.ts";
import { useMarketPlace } from "./market-place.ts";
import { ListSkeleton, MarketPage, Quiet } from "./market-rows.tsx";

/**
 * The review before an install or an update (ADR 0168 §8), in plain sentences: what it is and who
 * published it, what it can do, then the person's choices: a recipe's needs (required ones on,
 * optional ones off) and whether its routines start, or which bots get a plugin. Nothing is
 * installed until Install, with the switches as they are.
 */
export function MarketReviewScreen(props: { entry: EntryKey; update: boolean }) {
  const read = useMarketEntry(props.entry);
  const block = read.data && installBlock(read.data.entry);
  const review = useMarketReview(props.entry, {
    update: props.update,
    enabled: read.data !== undefined && !block,
  });
  const title = read.data?.entry.summary.title ?? "Review";
  return (
    <MarketPage page="market-entry" variant="review" title={`Review ${title}`}>
      {block ? (
        <Quiet>{block}</Quiet>
      ) : review.isError || read.isError ? (
        <Quiet>{failureSentence(review.error ?? read.error, "review")}</Quiet>
      ) : !review.data ? (
        <ListSkeleton />
      ) : (
        <ReviewBody key={review.data.review.id} entry={props.entry} prepared={review.data} />
      )}
    </MarketPage>
  );
}

function ReviewBody(props: { entry: EntryKey; prepared: PreparedReview }) {
  const { review, items } = props.prepared;
  const body = review.body;
  const place = useMarketPlace();
  const navigate = useNavigate();
  const install = useInstall();
  const cancel = useCancelReview();
  const [needs, setNeeds] = useState(() =>
    body.type === "spade-bot" ? needDefaults(body.needs) : {},
  );
  const [startRoutines, setStartRoutines] = useState(false);
  const [bots, setBots] = useState<readonly string[]>([]);
  const [failed, setFailed] = useState<string>();
  const suit = suitFromReview(review, items);
  const back = () =>
    void navigate({
      to: "/marketplace/$source/$type/$name",
      params: props.entry,
      search: place.filterSearch,
    });
  const run = () => {
    setFailed(undefined);
    install.mutate(
      { review, choices: { bots: [...bots], needs, startRoutines } },
      {
        onSuccess: (answer) => {
          const bot = review.type === "spade-bot" ? answer.installed?.target : undefined;
          if (bot) void navigate({ to: "/spade/$agentId", params: { agentId: bot } });
          else back();
        },
        onError: (error) => setFailed(failureSentence(error, "install")),
      },
    );
  };
  return (
    <>
      <div className="mt-2 flex flex-col gap-1 text-md text-foreground">
        <p>{whatItIs(review)}</p>
        {!review.reviewed && !review.byAce && <p>Not reviewed by ace.</p>}
        {review.updates && <p>Replaces version {review.updates}, which stays until you install.</p>}
        {canDoSentences(review).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {suit && <SuitLook suit={suit} />}
      {body.type === "spade-bot" && (
        <RecipeFacts body={body}>
          {body.needs.length > 0 && (
            <SettingSection label="Needs">
              {body.needs.map((need) => (
                <SwitchRow
                  key={need.key}
                  title={need.label}
                  description={`${need.why} ${need.required ? "Required." : "Optional."}`}
                  checked={needs[need.key] === true}
                  onChange={(on) => setNeeds((before) => ({ ...before, [need.key]: on }))}
                />
              ))}
            </SettingSection>
          )}
          {body.routines.length > 0 && (
            <SettingSection label="Routines">
              <RoutineRows body={body} />
              <SwitchRow
                title="Start its routines"
                checked={startRoutines}
                onChange={setStartRoutines}
              />
            </SettingSection>
          )}
        </RecipeFacts>
      )}
      {body.type === "spade-plugin" && <BotChoice chosen={bots} onChange={setBots} />}
      <ReviewItems items={items} />
      {(review.blocked || failed) && (
        <p role="alert" className="mt-6 text-ui text-destructive">
          {failed ?? review.blocked}
        </p>
      )}
      <div className="mt-8 flex justify-end gap-2">
        <Button
          variant="ghost"
          disabled={install.isPending}
          onClick={() => {
            cancel(review);
            back();
          }}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={install.isPending || review.blocked !== undefined}
          onClick={run}
        >
          {install.isPending ? "Installing…" : "Install"}
        </Button>
      </div>
    </>
  );
}

/** "Harbour dusk 1.2.0 is a Suit by ace." */
function whatItIs(review: MarketReview): string {
  const by = byline(review);
  const kind = typeWord(review.type).toLowerCase();
  const article = /^[aeiou]/.test(kind) ? "an" : "a";
  return `${review.title} ${review.version} is ${article} ${kind}${by ? `, ${by.charAt(0).toLowerCase()}${by.slice(1)}` : ""}.`;
}

function SwitchRow(props: {
  title: string;
  description?: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  const id = useId();
  return (
    <SettingRow inline htmlFor={id} title={props.title} description={props.description}>
      <Switch id={id} checked={props.checked} onCheckedChange={props.onChange} />
    </SettingRow>
  );
}

/** A plugin's bots: each of Spade's bots on this machine as a switch, all off until chosen. */
function BotChoice(props: { chosen: readonly string[]; onChange(bots: readonly string[]): void }) {
  const client = useClient();
  const agents = useDaemonQuery({
    queryKey: ["marketplace", "bots"],
    read: (_client, signal) => readAgents(client, { signal }),
    retry: false,
  });
  const bots = agents.data?.filter((agent) => agent.kind === "bot") ?? [];
  if (!bots.length)
    return agents.isError || agents.data ? (
      <p className="mt-6 text-ui text-muted-foreground">
        {agents.isError
          ? "Spade isn't running, so no bot gets it yet."
          : "No bots yet. You can allow it for a bot later."}
      </p>
    ) : null;
  return (
    <SettingSection label="Bots that get it">
      {bots.map((bot) => (
        <SwitchRow
          key={bot.id}
          title={bot.name}
          description={bot.task.split("\n")[0] ?? ""}
          checked={props.chosen.includes(bot.id)}
          onChange={(on) =>
            props.onChange(
              on ? [...props.chosen, bot.id] : props.chosen.filter((id) => id !== bot.id),
            )
          }
        />
      ))}
    </SettingSection>
  );
}
