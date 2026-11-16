import { useClient } from "@ace/client-react";
import type { MarketReview } from "@ace/protocol/marketplace";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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
import { Empty, publisherName } from "./market-card.tsx";
import { Facts } from "./market-entry-parts.tsx";
import { faceFromReview, suitFromReview } from "./market-looks.ts";
import {
  canDoSentences,
  failureSentence,
  installBlock,
  needDefaults,
  typeWord,
} from "./market-model.ts";
import { Status } from "./market-marks.tsx";
import { offlineTitle, useMarketNav } from "./market-nav.ts";
import { ReviewItems } from "./market-review-items.tsx";
import { AppMark, BotPicture, SuitPicture } from "./market-stage.tsx";

/*
 * The review before an install or an update (ADR 0168 §8), as a form page: what it is, in plain
 * sentences; a recipe's apps as switches (required ones on, optional ones off) and whether its
 * routines start; which bots get a plugin; what it runs and its files. Nothing installs until
 * Install, with the switches as they are; an update is reviewed and installed on its own.
 */

export function ReviewPage(props: { entry: EntryKey; update: boolean }) {
  const read = useMarketEntry(props.entry);
  const block = read.data && installBlock(read.data.entry);
  const review = useMarketReview(props.entry, {
    update: props.update,
    enabled: read.data !== undefined && !block,
  });
  const title = read.data?.entry.summary.title ?? "";
  if (block)
    return (
      <div className="mk-inner" data-width="form">
        <h1 className="mk-display-sm" style={{ marginTop: 8 }}>
          Review {title}
        </h1>
        <p className="mk-withdrawn-line" style={{ marginTop: 16 }}>
          {block}
        </p>
      </div>
    );
  if (review.isError || read.isError)
    return <Empty title={failureSentence(review.error ?? read.error, "review")} />;
  if (!review.data) return null;
  return <ReviewBody key={review.data.review.id} prepared={review.data} />;
}

/** "From market.acehq.dev, reviewed by ace." */
function fromLine(review: MarketReview) {
  const from = review.from ? review.from.replace(/^https:\/\//, "") : "market.acehq.dev";
  return `From ${from}${review.reviewed || review.byAce ? ", reviewed by ace" : ""}.`;
}

function ReviewBody(props: { prepared: PreparedReview }) {
  const { review, items } = props.prepared;
  const body = review.body;
  const nav = useMarketNav();
  const navigate = useNavigate();
  const install = useInstall();
  const cancel = useCancelReview();
  const [needs, setNeeds] = useState(() =>
    body.type === "spade-bot" ? needDefaults(body.needs) : {},
  );
  const [startRoutines, setStartRoutines] = useState(false);
  const [bots, setBots] = useState<readonly string[]>([]);
  const [failed, setFailed] = useState<string>();
  const recipe = body.type === "spade-bot" ? body : undefined;
  const missing =
    recipe?.needs.filter((need) => need.required && !needs[need.key]).map((need) => need.label) ??
    [];
  const stuck =
    review.blocked ??
    (missing.length ? `${review.title} can't work without ${missing.join(" and ")}.` : undefined);
  const run = () => {
    setFailed(undefined);
    install.mutate(
      { review, choices: { bots: [...bots], needs, startRoutines } },
      {
        onSuccess: (answer) => {
          const bot = review.type === "spade-bot" ? answer.installed?.target : undefined;
          if (bot) {
            nav.close();
            void navigate({ to: "/spade/$agentId", params: { agentId: bot } });
          } else nav.back();
        },
        onError: (error) => setFailed(failureSentence(error, "install")),
      },
    );
  };
  const who = publisherName(review);
  const lines = [
    fromLine(review),
    ...(review.updates
      ? [`Replaces version ${review.updates}, which stays until you install.`]
      : []),
    ...canDoSentences(review),
  ];
  return (
    <div className="mk-inner" data-width="form" data-variant="review">
      <div style={{ display: "flex", gap: 20, alignItems: "center", marginTop: 8 }}>
        {review.type === "spade-bot" ? (
          <BotPicture
            face={faceFromReview(review)}
            size={64}
            style={{ width: 96, aspectRatio: "1" }}
          />
        ) : (
          <div style={{ width: 160, flex: "none" }}>
            {review.type === "suit" ? <SuitPicture suit={suitFromReview(review, items)} /> : null}
          </div>
        )}
        <div style={{ display: "grid", gap: 4 }}>
          <h1 className="mk-display-sm">Review {review.title}</h1>
          <span className="mk-line">
            {[typeWord(review.type), who, review.version].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>
      <div className="mk-sentences" style={{ marginTop: 32 }}>
        {!review.reviewed && !review.byAce && (
          <Status tone="needs">
            Not reviewed by ace. Read what it does before you install it.
          </Status>
        )}
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {recipe && recipe.needs.length > 0 && (
        <>
          <h3 className="mk-quiet-head">Apps</h3>
          {recipe.needs.map((need) => (
            <div key={need.key} className="mk-fact-row">
              <AppMark name={need.label} size={32} />
              <span className="mk-words">
                <span className="mk-name">{need.label}</span>
                <span className="mk-meta">
                  {need.why} {need.required ? "Required." : "Optional."}
                </span>
              </span>
              <Switch
                aria-label={need.label}
                checked={needs[need.key] === true}
                onCheckedChange={(on) => setNeeds((before) => ({ ...before, [need.key]: on }))}
              />
            </div>
          ))}
        </>
      )}
      {recipe && recipe.routines.length > 0 && (
        <>
          <h3 className="mk-quiet-head">Routines</h3>
          {recipe.routines.map((routine) => (
            <div key={routine.name} className="mk-fact-row">
              <span className="mk-words">
                <span className="mk-name">{routine.name}</span>
                <span className="mk-meta">{routine.schedule}</span>
              </span>
            </div>
          ))}
          <div className="mk-fact-row">
            <span className="mk-words">
              <span className="mk-name">Start its routines</span>
            </span>
            <Switch
              aria-label="Start its routines"
              checked={startRoutines}
              onCheckedChange={setStartRoutines}
            />
          </div>
        </>
      )}
      {body.type === "spade-plugin" && <BotChoice chosen={bots} onChange={setBots} />}
      <ReviewItems items={items} />
      <h3 className="mk-quiet-head">Version</h3>
      <Facts
        rows={[
          ["Version", review.version],
          [
            "Content hash",
            <span
              key="hash"
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
            >{`sha256:${review.hash.slice(0, 4)}…${review.hash.slice(-4)}`}</span>,
          ],
        ]}
      />
      <div className="mk-foot">
        <div className="mk-foot-inner">
          <span
            className="mk-grow"
            role={failed || stuck ? "alert" : undefined}
            data-tone={failed || stuck ? "failed" : undefined}
          >
            {failed ?? stuck ?? ""}
          </span>
          <Button
            variant="ghost"
            size="lg"
            disabled={install.isPending}
            onClick={() => {
              cancel(review);
              nav.back();
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={install.isPending || stuck !== undefined || nav.offline}
            title={nav.offline ? offlineTitle("Install") : undefined}
            onClick={run}
          >
            {install.isPending ? "Installing…" : "Install"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A plugin's bots: each of Spade's bots as a switch, all off until chosen. */
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
      <p className="mk-line" style={{ marginTop: 24 }}>
        {agents.isError
          ? "Spade isn't running, so no bot gets it yet."
          : "No bots yet. You can allow it for a bot later."}
      </p>
    ) : null;
  return (
    <>
      <h3 className="mk-quiet-head">Bots that get it</h3>
      {bots.map((bot) => (
        <div key={bot.id} className="mk-fact-row">
          <span className="mk-words">
            <span className="mk-name">{bot.name}</span>
            <span className="mk-meta mk-clamp1">{bot.task.split("\n")[0] ?? ""}</span>
          </span>
          <Switch
            aria-label={bot.name}
            checked={props.chosen.includes(bot.id)}
            onCheckedChange={(on) =>
              props.onChange(
                on ? [...props.chosen, bot.id] : props.chosen.filter((id) => id !== bot.id),
              )
            }
          />
        </div>
      ))}
    </>
  );
}
