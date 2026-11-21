import type { MarketEntryDetail, MarketReviewBody } from "@ace/protocol/marketplace";
import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { AppMark } from "@/components/ui/app-mark.tsx";
import { useTheme } from "@/theme/theme-provider.tsx";
import { part } from "@/lib/suit-part.ts";
import { useMarketEntry, useMarketReview, useMarketSearch, type EntryKey } from "./market-api.ts";
import { EntryByline, Empty, publisherName } from "./market-card.tsx";
import { EntryBlocked, EntrySub, useWearing } from "./market-entry-parts.tsx";
import { useInLibrary, useSuitLook } from "./market-looks.ts";
import {
  canDoSentences,
  dateText,
  entryAction,
  failureSentence,
  needCatalogue,
  sizeText,
  typeWord,
} from "./market-model.ts";
import { offlineTitle, useMarketNav } from "./market-nav.ts";
import { SuitPicture, Stage } from "./market-stage.tsx";
import {
  EntryIcon,
  EntryRow,
  entryKeyOf,
  GetButton,
  Shelf,
  StoreRows,
  useInstalledCopy,
} from "./market-store-row.tsx";

/*
 * One entry's page, the same for every kind: its icon (a bot's face, a Suit's window, a tool's
 * glyph), name, one line and maker, with its one button (Get, Update or Open; a Suit adds Try it).
 * Then its preview, what it is, what it may do in plain words, what's new, the facts, and more
 * from its maker. Its review is prepared here once, so Get opens it at once.
 */

/** The description, when it says more than the one line above it. */
export function moreWords(detail: MarketEntryDetail): string | undefined {
  const words = detail.description.trim();
  return words && words !== detail.summary.line.trim() ? detail.description : undefined;
}

type Recipe = Extract<MarketReviewBody, { type: "spade-bot" }>;

export function EntryPage(props: { entry: EntryKey }) {
  const read = useMarketEntry(props.entry);
  const detail = read.data?.entry;
  // Prepared once, read by the page and by Get.
  const review = useMarketReview(props.entry, {
    update: false,
    enabled: detail !== undefined && entryAction(detail) !== "none",
  }).data?.review;
  if (!detail) return read.isError ? <Empty title={failureSentence(read.error, "read")} /> : null;
  const recipe: Recipe | undefined = review?.body.type === "spade-bot" ? review.body : undefined;
  const suit = detail.summary.type === "suit";
  const more = moreWords(detail);
  const canDo = review ? canDoSentences(review) : [];
  return (
    <article className="st-page" aria-label={detail.summary.title}>
      <EntryHeader detail={detail} entry={props.entry}>
        {suit ? <SuitActions entry={props.entry} detail={detail} /> : <Action detail={detail} />}
      </EntryHeader>
      {suit ? <SuitPreview entry={props.entry} detail={detail} /> : <Previews detail={detail} />}
      {more && (
        <Section title="About">
          <p className="st-prose">{more}</p>
        </Section>
      )}
      {(canDo.length > 0 || recipe) && (
        <Section title="What it may do">
          <ul className="st-list">
            {canDo.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {recipe && <RecipeLists body={recipe} />}
        </Section>
      )}
      <WhatsNew detail={detail} />
      <Section title="Information">
        <Information detail={detail} recipe={recipe} />
      </Section>
      <MoreFrom detail={detail} />
    </article>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="st-section" aria-label={props.title}>
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

function EntryHeader(props: { detail: MarketEntryDetail; entry: EntryKey; children: ReactNode }) {
  const { summary } = props.detail;
  return (
    <header className="st-head">
      <EntryIcon entry={summary} size="page" />
      <div className="st-head-words">
        <h1 {...part("page-title", undefined, "market")} className="st-title">
          {summary.title}
        </h1>
        <p className="st-lead">{summary.line}</p>
        <div className="st-by">
          <EntrySub entry={summary} />
        </div>
        <EntryBlocked detail={props.detail} />
        <div className="st-actions">{props.children}</div>
      </div>
    </header>
  );
}

/** Get, Update or Open; nothing when it can't be installed. */
function Action(props: { detail: MarketEntryDetail }) {
  if (entryAction(props.detail) === "none") return null;
  return <GetButton entry={props.detail.summary} size="lg" primary />;
}

/** A Suit's: Try it beside Get, or Wear it once it's here. */
function SuitActions(props: { entry: EntryKey; detail: MarketEntryDetail }) {
  const nav = useMarketNav();
  const { summary, installed } = props.detail;
  const inLibrary = useInLibrary(summary.type, summary.name) && !installed;
  const worn = useWearing(inLibrary ? summary.name : installed?.target);
  const offline = nav.offline;
  const here = inLibrary || (installed?.state === "on" && !installed.update);
  if (worn.wearing) return <span className="st-state">Wearing</span>;
  return (
    <>
      {inLibrary && <span className="st-state">In your Suits</span>}
      {here ? (
        <Button variant="primary" size="lg" onClick={worn.wear}>
          Wear it
        </Button>
      ) : (
        <Action detail={props.detail} />
      )}
      {!here && (
        <Button
          variant="secondary"
          size="lg"
          disabled={offline}
          title={offline ? offlineTitle("Try it") : undefined}
          onClick={() => nav.tryOn(props.entry, summary.title, publisherName(summary))}
        >
          Try it
        </Button>
      )}
    </>
  );
}

function SuitPreview(props: { entry: EntryKey; detail: MarketEntryDetail }) {
  const suit = useSuitLook(props.entry, props.detail.installed?.target);
  const shown = useTheme().resolved.scheme;
  const [picked, setPicked] = useState<"light" | "dark">();
  const scheme = picked ?? shown;
  const both = suit ? suit.summary.schemes.length > 1 : false;
  return (
    <div className="st-preview">
      <SuitPicture suit={suit} scheme={scheme} />
      {both && (
        <div className="mt-3 flex justify-end">
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
    </div>
  );
}

/** A listing's own pictures, when it has them. */
function Previews(props: { detail: MarketEntryDetail }) {
  const previews = props.detail.summary.previews;
  if (!previews?.length) return null;
  return (
    <div className="st-preview">
      <Stage entry={{ ...props.detail.summary, previews }} size="large" />
    </div>
  );
}

/** A recipe's routines, apps and what it brings, under what it may do. */
function RecipeLists(props: { body: Recipe }) {
  const { body } = props;
  return (
    <ul className="st-list" style={{ marginTop: 12 }}>
      {body.needs.map((need) => (
        <li key={need.key} style={{ alignItems: "center" }}>
          <AppMark catalogue={needCatalogue(need.key)} name={need.label} size="fact" />
          <span>
            {`Uses ${need.label}`}
            <span className="st-sub">{` · ${need.why}${need.required ? "" : " · optional"}`}</span>
          </span>
        </li>
      ))}
      {body.routines.map((routine) => (
        <li key={routine.name}>
          <span>
            {`Runs ${routine.name}`}
            <span className="st-sub">{` · ${routine.schedule} · starts paused`}</span>
          </span>
        </li>
      ))}
      {body.brings.map((brought) => (
        <li key={`${brought.type}/${brought.name}`}>
          <span>
            {`Brings ${brought.name}`}
            <span className="st-sub">{` · ${typeWord(brought.type)}`}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The newest version, and the one installed here when they differ. */
function WhatsNew(props: { detail: MarketEntryDetail }) {
  const latest = props.detail.versions[0];
  const copy = useInstalledCopy(props.detail.summary);
  if (!latest) return null;
  return (
    <Section title="What's new">
      <p className="st-prose">
        {`Version ${latest.version} · ${dateText(latest.published)}`}
        {copy?.update
          ? `. You have ${copy.version}; the update gets its own short review.`
          : copy
            ? ". You have it."
            : ""}
      </p>
    </Section>
  );
}

function Information(props: { detail: MarketEntryDetail; recipe: Recipe | undefined }) {
  const { summary, versions } = props.detail;
  const latest = versions[0];
  const rows: [string, ReactNode][] = [
    ["Made by", <EntryByline key="by" entry={summary} />],
    ["Kind", typeWord(summary.type)],
    ["Version", latest?.version ?? summary.version ?? "—"],
  ];
  if (latest) rows.push(["Size", sizeText(latest.size)]);
  rows.push(["Downloads", summary.downloads.toLocaleString("en-US")]);
  if (props.recipe) rows.push(["Model", `Your ${props.recipe.model} model`]);
  rows.push(["Source", summary.from?.replace(/^https:\/\//, "") ?? "market.acehq.dev"]);
  return (
    <dl className="st-info">
      {rows.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Up to six more by the same maker, as rows. */
function MoreFrom(props: { detail: MarketEntryDetail }) {
  const found = useMarketSearch({ query: "" });
  const { summary } = props.detail;
  const by = summary.byAce ? "ace" : summary.publisher?.id;
  const more = (found.data?.entries ?? [])
    .filter(
      (other) =>
        (other.byAce ? "ace" : other.publisher?.id) === by &&
        entryKeyOf(other) !== entryKeyOf(summary),
    )
    .slice(0, 6);
  if (!by || !more.length) return null;
  const title = `More from ${publisherName(summary) ?? ""}`;
  return (
    <Shelf title={title}>
      <StoreRows label={title} cols={2}>
        {more.map((other) => (
          <EntryRow key={entryKeyOf(other)} entry={other} />
        ))}
      </StoreRows>
    </Shelf>
  );
}
