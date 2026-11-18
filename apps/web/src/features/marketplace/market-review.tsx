import { useClient } from "@ace/client-react";
import type { MarketInstalled, MarketReview, MarketReviewBody } from "@ace/protocol/marketplace";
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
import { useWearing } from "./market-entry-parts.tsx";
import { faceFromReview, suitFromReview, useInLibrary, useLibrarySuit } from "./market-looks.ts";
import {
  canDoSentences,
  failureSentence,
  findingSentences,
  installBlock,
  MarketFailure,
  needDefaults,
  typeWord,
} from "./market-model.ts";
import { Status } from "./market-marks.tsx";
import { offlineTitle, useMarketNav } from "./market-nav.ts";
import { reviewFailure, ReviewFoot, type ReviewFailure } from "./market-review-foot.tsx";
import { ReviewItems, ReviewTexts } from "./market-review-items.tsx";
import { ShowFiles, SuitLooks } from "./market-review-suit.tsx";
import { AppMark, BotPicture } from "./market-stage.tsx";

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
  // The device's own scan refused these bytes: no review, no Install, and why in sentences.
  const scanned =
    review.error instanceof MarketFailure && review.error.code === "blocked"
      ? review.error.scan
      : undefined;
  if (block || scanned)
    return (
      <div className="mk-inner" data-width="form">
        <h1 className="mk-display-sm" style={{ marginTop: 8 }}>
          {title}
        </h1>
        <p role="alert" className="mk-withdrawn-line" style={{ marginTop: 16 }}>
          {block ?? "ace's scan on this device refused it, so it can't be installed."}
        </p>
        {scanned && (
          <div className="mk-sentences" style={{ marginTop: 16 }}>
            {findingSentences(scanned).map((found) => (
              <p key={found}>{found}</p>
            ))}
          </div>
        )}
      </div>
    );
  if (review.isError || read.isError)
    return <Empty title={failureSentence(review.error ?? read.error, "review")} />;
  if (!review.data) return null;
  return (
    <ReviewBody
      key={review.data.review.id}
      prepared={review.data}
      installed={read.data?.entry.installed}
    />
  );
}

/** "From market.acehq.dev, reviewed by ace." */
function fromLine(review: MarketReview) {
  const from = review.from ? review.from.replace(/^https:\/\//, "") : "market.acehq.dev";
  return `From ${from}${review.reviewed || review.byAce ? ", reviewed by ace" : ""}.`;
}

function ReviewBody(props: { prepared: PreparedReview; installed: MarketInstalled | undefined }) {
  const { review, items } = props.prepared;
  // A Suit with this id is already here (built in, or made here) and wasn't installed from the
  // market: there is nothing to install, only to wear.
  const inLibrary = useInLibrary(review.type, review.name) && !props.installed && !review.updates;
  // The look these bytes set; the library's own copy (with its thumbnails) when that is the one
  // the person would wear, or when the review carries no suit.json.
  const library = useLibrarySuit(
    review.type === "suit" ? (props.installed?.target ?? review.name) : undefined,
  );
  const reviewed = suitFromReview(review, items);
  const look = inLibrary ? (library ?? reviewed) : (reviewed ?? library);
  const worn = useWearing(inLibrary ? review.name : undefined);
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
  const [failed, setFailed] = useState<ReviewFailure>();
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
        onError: (error) => setFailed(reviewFailure(error)),
      },
    );
  };
  const who = publisherName(review);
  const lines = [
    ...(inLibrary
      ? [`${review.title} is already in your Suits, so there's nothing to install.`]
      : []),
    fromLine(review),
    ...(review.updates
      ? [`Replaces version ${review.updates}, which stays until you install.`]
      : []),
    ...canDoSentences(review),
    ...(review.deprecated ? [`Its publisher deprecated this version: ${review.deprecated}`] : []),
  ];
  const found = findingSentences(review.scan);
  return (
    <div className="mk-inner" data-width="form" data-variant="review">
      <div style={{ display: "flex", gap: 20, alignItems: "center", marginTop: 8 }}>
        {review.type === "spade-bot" && (
          <BotPicture
            face={faceFromReview(review)}
            size={64}
            style={{ width: 96, aspectRatio: "1" }}
          />
        )}
        <div style={{ display: "grid", gap: 4 }}>
          <h1 className="mk-display-sm">{review.title}</h1>
          <span className="mk-line">
            {[typeWord(review.type), who, review.version].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>
      {review.type === "suit" && <SuitLooks suit={look} />}
      {!review.reviewed && !review.byAce && (
        <div style={{ marginTop: 24 }}>
          <Status tone="needs">
            Not reviewed by ace. Read what it does before you install it.
          </Status>
        </div>
      )}
      <ul className="mk-review-facts" aria-label="What it is">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {found.length > 0 && (
        <>
          <h3 className="mk-quiet-head">What ace's scan found</h3>
          <div className="mk-sentences" aria-label="What ace's scan found">
            {found.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </>
      )}
      {recipe && (
        <RecipeChoices
          recipe={recipe}
          needs={needs}
          onNeeds={setNeeds}
          start={startRoutines}
          onStart={setStartRoutines}
        />
      )}
      {body.type === "spade-plugin" && <BotChoice chosen={bots} onChange={setBots} />}
      <ReviewItems items={items} />
      {review.type !== "suit" && <ReviewTexts items={items} />}
      <ShowFiles items={items} hash={review.hash}>
        {review.type === "suit" && <ReviewTexts items={items} />}
      </ShowFiles>
      <ReviewFoot stuck={stuck} failure={failed} onSignedIn={run}>
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
        {inLibrary ? (
          worn.wearing ? (
            <span className="mk-state-word">Wearing</span>
          ) : (
            <Button variant="primary" size="lg" onClick={worn.wear}>
              Wear it
            </Button>
          )
        ) : (
          <Button
            variant="primary"
            size="lg"
            disabled={install.isPending || stuck !== undefined || nav.offline}
            title={nav.offline ? offlineTitle("Install") : undefined}
            onClick={run}
          >
            {install.isPending ? "Installing…" : "Install"}
          </Button>
        )}
      </ReviewFoot>
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

type Recipe = Extract<MarketReviewBody, { type: "spade-bot" }>;

/** A recipe's apps as switches (required ones on) and whether its routines start. */
function RecipeChoices(props: {
  recipe: Recipe;
  needs: Readonly<Record<string, boolean>>;
  onNeeds(next: (before: Record<string, boolean>) => Record<string, boolean>): void;
  start: boolean;
  onStart(start: boolean): void;
}) {
  const { recipe } = props;
  return (
    <>
      {recipe.needs.length > 0 && (
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
                checked={props.needs[need.key] === true}
                onCheckedChange={(on) => props.onNeeds((before) => ({ ...before, [need.key]: on }))}
              />
            </div>
          ))}
        </>
      )}
      {recipe.routines.length > 0 && (
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
              checked={props.start}
              onCheckedChange={props.onStart}
            />
          </div>
        </>
      )}
    </>
  );
}
