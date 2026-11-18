import type { MarketEntryDetail, MarketReviewBody } from "@ace/protocol/marketplace";
import type { CSSProperties } from "react";
import { useState } from "react";
import { botFaceColourVars } from "@ace/ui-core/bot-face";
import { BotFace } from "@/components/bot-face.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useTheme } from "@/theme/theme-provider.tsx";
import { suitPalette } from "@/theme/suits/suit-css.ts";
import { useMarketEntry, useMarketReview, type EntryKey } from "./market-api.ts";
import { Empty, publisherName } from "./market-card.tsx";
import {
  EntryBlocked,
  EntrySub,
  Facts,
  InstallAction,
  MoreFrom,
  PublisherMini,
  useWearing,
  versionFacts,
} from "./market-entry-parts.tsx";
import { faceFromReview, useSuitLook } from "./market-looks.ts";
import { canDoSentences, entryAction, failureSentence, typeWord } from "./market-model.ts";
import { TypeMark } from "./market-marks.tsx";
import { offlineTitle, useMarketNav } from "./market-nav.ts";
import { AppMark, SuitPicture, Stage } from "./market-stage.tsx";
import { part } from "@/lib/suit-part.ts";

/*
 * One entry, as a page pushed over its place: a bot with its face large on its colour and what
 * it brings, a Suit as the ace window in its palette with Try it, a skill or plugin with its name
 * set in mono. Its review is prepared here once, so Install opens it at once.
 */

export function EntryPage(props: { entry: EntryKey }) {
  const read = useMarketEntry(props.entry);
  const detail = read.data?.entry;
  if (!detail) return read.isError ? <Empty title={failureSentence(read.error, "read")} /> : null;
  if (detail.summary.type === "spade-bot") return <BotPage entry={props.entry} detail={detail} />;
  if (detail.summary.type === "suit") return <SuitPage entry={props.entry} detail={detail} />;
  return <ToolPage entry={props.entry} detail={detail} />;
}

/** The review this page reads what it brings from; prepared while it could be installed. */
function useEntryReview(entry: EntryKey, detail: MarketEntryDetail) {
  const action = entryAction(detail);
  return useMarketReview(entry, { update: false, enabled: action === "install" });
}

type Recipe = Extract<MarketReviewBody, { type: "spade-bot" }>;

function BotPage(props: { entry: EntryKey; detail: MarketEntryDetail }) {
  const { summary } = props.detail;
  const review = useEntryReview(props.entry, props.detail).data?.review;
  const face = faceFromReview(review);
  const body: Recipe | undefined = review?.body.type === "spade-bot" ? review.body : undefined;
  const tint = face ? (botFaceColourVars(face) as CSSProperties) : undefined;
  return (
    <div className="mk-inner">
      <div className="mk-entry-hero" style={tint}>
        {face ? (
          <>
            <span className="mk-floor" />
            <BotFace face={face} size={220} />
          </>
        ) : (
          <TypeMark type="spade-bot" />
        )}
        <div className="mk-entry-hero-words">
          <span className="mk-line">Bot</span>
          <h1 {...part("page-title", undefined, "market")} className="mk-display">
            {summary.title}
          </h1>
          <p className="mk-lead">{summary.line}</p>
          <EntrySub entry={summary} />
          <EntryBlocked detail={props.detail} />
          <div className="mk-entry-actions" style={{ marginTop: 12 }}>
            <InstallAction entry={props.entry} detail={props.detail} />
          </div>
        </div>
      </div>
      <div className="mk-entry-body">
        <div>
          {props.detail.description && <p className="mk-prose">{props.detail.description}</p>}
          {body && <RecipeRows body={body} />}
        </div>
        <aside>
          <Facts
            rows={[
              ...versionFacts(props.detail),
              body && (["Model", `Your ${body.model} model`] as const),
            ]}
          />
          <PublisherMini entry={summary} />
        </aside>
      </div>
      <MoreFrom entry={summary} />
    </div>
  );
}

/** A recipe's routines, apps and the skills it brings, read only. */
function RecipeRows(props: { body: Recipe }) {
  const { body } = props;
  return (
    <>
      {body.routines.length > 0 && (
        <>
          <h3 {...part("section-title", undefined, "quiet")} className="mk-quiet-head">
            Routines
          </h3>
          {body.routines.map((routine) => (
            <div key={routine.name} className="mk-fact-row">
              <span className="mk-words">
                <span className="mk-name">{routine.name}</span>
                <span className="mk-meta">{routine.schedule}</span>
              </span>
              <span className="mk-state-word">Starts paused</span>
            </div>
          ))}
        </>
      )}
      {body.needs.length > 0 && (
        <>
          <h3 {...part("section-title", undefined, "quiet")} className="mk-quiet-head">
            Apps
          </h3>
          {body.needs.map((need) => (
            <div key={need.key} className="mk-fact-row">
              <AppMark name={need.label} size={32} />
              <span className="mk-words">
                <span className="mk-name">{need.label}</span>
                <span className="mk-meta">{need.why}</span>
              </span>
              <span className="mk-state-word">{need.required ? "Required" : "Optional"}</span>
            </div>
          ))}
        </>
      )}
      {body.brings.length > 0 && (
        <>
          <h3 {...part("section-title", undefined, "quiet")} className="mk-quiet-head">
            What it brings
          </h3>
          {body.brings.map((brought) => (
            <div key={`${brought.type}/${brought.name}`} className="mk-fact-row">
              <span className="mk-words">
                <span className="mk-name">{brought.name}</span>
                <span className="mk-meta">
                  {typeWord(brought.type)} · {brought.version}
                </span>
              </span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function SuitPage(props: { entry: EntryKey; detail: MarketEntryDetail }) {
  const nav = useMarketNav();
  const { summary, installed } = props.detail;
  const review = useEntryReview(props.entry, props.detail).data?.review;
  const suit = useSuitLook(props.entry, installed?.target);
  const shown = useTheme().resolved.scheme;
  const [picked, setPicked] = useState<"light" | "dark">();
  const scheme = picked ?? shown;
  const both = suit ? suit.summary.schemes.length > 1 : false;
  const worn = useWearing(installed?.target);
  const palette = suit ? suitPalette(suit.manifest, scheme) : undefined;
  const offline = nav.offline;
  const tryIt = (
    <Button
      variant="secondary"
      size="lg"
      disabled={offline}
      title={offline ? offlineTitle("Try it") : undefined}
      onClick={() => nav.tryOn(props.entry, summary.title, publisherName(summary))}
    >
      Try it
    </Button>
  );
  const actions = worn.wearing ? (
    <span className="mk-state-word">Wearing</span>
  ) : installed && installed.state === "on" && !installed.update ? (
    <>
      {tryIt}
      <Button variant="primary" size="lg" onClick={worn.wear}>
        Wear it
      </Button>
    </>
  ) : (
    <InstallAction
      entry={props.entry}
      detail={props.detail}
      extra={entryAction(props.detail) === "none" ? undefined : tryIt}
    />
  );
  return (
    <div className="mk-inner">
      <div className="mk-entry-head">
        <div className="mk-words">
          <span className="mk-line">Suit</span>
          <h1 {...part("page-title", undefined, "market")} className="mk-display">
            {summary.title}
          </h1>
          <EntrySub entry={summary} />
          <EntryBlocked detail={props.detail} />
        </div>
        <div className="mk-entry-actions">{actions}</div>
      </div>
      <div className="mk-preview-frame">
        {both && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
            <div className="mk-word-choice" role="group" aria-label="Preview">
              {(["dark", "light"] as const).map((each) => (
                <button
                  key={each}
                  type="button"
                  aria-pressed={scheme === each}
                  onClick={() => setPicked(each)}
                >
                  {each === "dark" ? "Dark" : "Light"}
                </button>
              ))}
            </div>
          </div>
        )}
        <SuitPicture suit={suit} scheme={scheme} />
      </div>
      <div className="mk-entry-body">
        <div>
          <p className="mk-prose" style={{ fontSize: "var(--mk-lead)" }}>
            {summary.line}
          </p>
          {props.detail.description && (
            <p className="mk-prose" style={{ marginTop: 16, color: "var(--mk-muted)" }}>
              {props.detail.description}
            </p>
          )}
          {review && (
            <div className="mk-sentences" style={{ marginTop: 16, color: "var(--mk-muted)" }}>
              {canDoSentences(review).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
        </div>
        <aside>
          <Facts
            rows={[
              palette &&
                ([
                  "Colours",
                  <span key="swatches" className="mk-swatches">
                    {(["s0", "s1", "t2", "t1", "accent"] as const).map((role) => (
                      <i key={role} style={{ background: palette[role] }} />
                    ))}
                  </span>,
                ] as const),
              ...versionFacts(props.detail),
            ]}
          />
          <PublisherMini entry={summary} />
        </aside>
      </div>
      <MoreFrom entry={summary} title={summary.byAce ? "More looks from ace" : undefined} />
    </div>
  );
}

function ToolPage(props: { entry: EntryKey; detail: MarketEntryDetail }) {
  const { summary } = props.detail;
  const review = useEntryReview(props.entry, props.detail).data?.review;
  return (
    <div className="mk-inner">
      <div className="mk-entry-head">
        <div className="mk-words">
          <span className="mk-line">{typeWord(summary.type)}</span>
          <h1 {...part("page-title", undefined, "market")} className="mk-display">
            {summary.title}
          </h1>
          <EntrySub entry={summary} />
          <EntryBlocked detail={props.detail} />
        </div>
        <div className="mk-entry-actions">
          <InstallAction entry={props.entry} detail={props.detail} />
        </div>
      </div>
      <div className="mk-preview-frame">
        <Stage entry={props.entry} size="large" style={{ aspectRatio: "16 / 6" }} />
      </div>
      <div className="mk-entry-body">
        <div>
          <p className="mk-prose" style={{ fontSize: "var(--mk-lead)" }}>
            {summary.line}
          </p>
          {props.detail.description && (
            <p className="mk-prose" style={{ marginTop: 16, color: "var(--mk-muted)" }}>
              {props.detail.description}
            </p>
          )}
          {review && (
            <div className="mk-sentences" style={{ marginTop: 16, color: "var(--mk-muted)" }}>
              {canDoSentences(review).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
        </div>
        <aside>
          <Facts rows={versionFacts(props.detail)} />
          <PublisherMini entry={summary} />
        </aside>
      </div>
      <MoreFrom entry={summary} />
    </div>
  );
}
