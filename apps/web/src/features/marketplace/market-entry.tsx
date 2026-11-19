import type { MarketEntryDetail, MarketReview, MarketReviewBody } from "@ace/protocol/marketplace";
import type { CSSProperties, ReactNode } from "react";
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
import { faceFromReview, useInLibrary, useSuitLook } from "./market-looks.ts";
import { canDoSentences, entryAction, failureSentence, typeWord } from "./market-model.ts";
import { offlineTitle, useMarketNav } from "./market-nav.ts";
import { AppMark, SuitPicture, Stage } from "./market-stage.tsx";
import { part } from "@/lib/suit-part.ts";

/*
 * One entry, as a page pushed over its place: a bot with its face large on its colour (once its
 * review shows it) and what it brings, a Suit as the ace window in its palette with Try it, a
 * skill or plugin with its listing's picture when it has one. Its review is prepared here once,
 * so Install opens it at once.
 */

/** The description, when it says more than the one line above it. */
export function moreWords(detail: MarketEntryDetail): string | undefined {
  const words = detail.description.trim();
  return words && words !== detail.summary.line.trim() ? detail.description : undefined;
}

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
  const more = moreWords(props.detail);
  return (
    <div className="mk-inner">
      {face ? (
        <div className="mk-entry-hero" style={tint}>
          <span className="mk-floor" />
          <BotFace face={face} size={220} />
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
      ) : (
        <EntryHead detail={props.detail}>
          <InstallAction entry={props.entry} detail={props.detail} />
        </EntryHead>
      )}
      <div className="mk-entry-body">
        <div>
          {face && more && <p className="mk-prose">{more}</p>}
          {!face && <Words detail={props.detail} />}
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
  // Already in the library (built into ace, or made here) and not from the market: wear it.
  const inLibrary = useInLibrary(summary.type, summary.name) && !installed;
  const worn = useWearing(inLibrary ? summary.name : installed?.target);
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
  ) : inLibrary ? (
    <>
      <span className="mk-state-word">In your Suits</span>
      <Button variant="primary" size="lg" onClick={worn.wear}>
        Wear it
      </Button>
    </>
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
      <EntryHead detail={props.detail}>{actions}</EntryHead>
      <div className="mk-preview-frame">
        {both && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
            <div
              {...part("tabs", undefined, "words")}
              className="mk-word-choice"
              role="group"
              aria-label="Preview"
            >
              {(["dark", "light"] as const).map((each) => (
                <button
                  key={each}
                  type="button"
                  {...part("tab", scheme === each && "selected")}
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
        <Words detail={props.detail} review={review} />
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
  const previews = summary.previews;
  return (
    <div className="mk-inner">
      <EntryHead detail={props.detail}>
        <InstallAction entry={props.entry} detail={props.detail} />
      </EntryHead>
      {previews?.length ? (
        <div className="mk-preview-frame">
          <Stage entry={{ ...props.entry, previews }} size="large" />
        </div>
      ) : null}
      <div className="mk-entry-body">
        <Words detail={props.detail} review={review} />
        <aside>
          <Facts rows={versionFacts(props.detail)} />
          <PublisherMini entry={summary} />
        </aside>
      </div>
      <MoreFrom entry={summary} />
    </div>
  );
}

/** An entry's title, kind and publisher, with its actions at the right. */
function EntryHead(props: { detail: MarketEntryDetail; children: ReactNode }) {
  const { summary } = props.detail;
  return (
    <div className="mk-entry-head">
      <div className="mk-words">
        <span className="mk-line">{typeWord(summary.type)}</span>
        <h1 {...part("page-title", undefined, "market")} className="mk-display">
          {summary.title}
        </h1>
        <EntrySub entry={summary} />
        <EntryBlocked detail={props.detail} />
      </div>
      <div className="mk-entry-actions">{props.children}</div>
    </div>
  );
}

/** The one line, the description when it says more, and what the review says it can do. */
function Words(props: { detail: MarketEntryDetail; review?: MarketReview | undefined }) {
  const more = moreWords(props.detail);
  return (
    <div>
      <p className="mk-prose" style={{ fontSize: "var(--mk-lead)" }}>
        {props.detail.summary.line}
      </p>
      {more && (
        <p className="mk-prose" style={{ marginTop: 16, color: "var(--mk-muted)" }}>
          {more}
        </p>
      )}
      {props.review && (
        <div className="mk-sentences" style={{ marginTop: 16, color: "var(--mk-muted)" }}>
          {canDoSentences(props.review).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}
