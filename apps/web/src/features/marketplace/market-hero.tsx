import type { MarketEntrySummary } from "@ace/protocol/marketplace";
import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { BotFace } from "@/components/bot-face.tsx";
import { Button } from "@/components/ui/button.tsx";
import { botFaceColourVars } from "@ace/ui-core/bot-face";
import { part } from "@/lib/suit-part.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { EntryByline, publisherName } from "./market-card.tsx";
import { useBotLook, useSuitLook } from "./market-looks.ts";
import { typeWord } from "./market-model.ts";
import { TypeMark } from "./market-marks.tsx";
import { offlineTitle, openEntry, useMarketNav, type MarketNav } from "./market-nav.ts";
import { Stage } from "./market-stage.tsx";
import { lookScope, Shot } from "./market-window.tsx";

/*
 * Discover's hero: one featured entry at a time as a large slide (a Suit in its own palette over
 * its picture, a bot's face on its colour), and the picks beside it that switch the slide. The
 * width decides its form (market-widths.css): picks beside it, picks as a strip under it, words
 * above the preview, and on a phone the slides swipe.
 */

export function Hero(props: { featured: readonly MarketEntrySummary[] }) {
  const [shown, setShown] = useState(0);
  const picks = props.featured.slice(0, 5);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = (shown + (event.key === "ArrowDown" ? 1 : picks.length - 1)) % picks.length;
    setShown(next);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };
  return (
    <div {...part("market-hero")} className="mk-hero">
      <div className="mk-slides" aria-roledescription="carousel" aria-label="Featured">
        {picks.map((entry, at) => (
          <Slide key={`${entry.type}/${entry.name}`} entry={entry} on={at === shown} />
        ))}
      </div>
      <div className="mk-picks" role="tablist" aria-label="Featured" onKeyDown={onKey}>
        {picks.map((entry, at) => (
          <button
            key={`${entry.type}/${entry.name}`}
            type="button"
            role="tab"
            aria-selected={at === shown}
            tabIndex={at === shown ? 0 : -1}
            className="mk-pick"
            onClick={() => setShown(at)}
          >
            <Stage entry={entry} size="small" />
            <span className="mk-pick-words">
              <span className="mk-name mk-clamp1">{entry.title}</span>
              <span className="mk-meta mk-clamp1">
                {[typeWord(entry.type), publisherName(entry)].filter(Boolean).join(" · ")}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const slideVars = {
  "--slide-bg": "var(--sidebar)",
  "--slide-ink": "var(--foreground)",
  "--slide-muted": "var(--muted-foreground)",
  "--slide-accent": "var(--ring)",
  "--slide-accent-fg": "var(--ring-foreground)",
} as CSSProperties;

function Slide(props: { entry: MarketEntrySummary; on: boolean }) {
  return props.entry.type === "suit" ? <SuitSlide {...props} /> : <OtherSlide {...props} />;
}

function SuitSlide(props: { entry: MarketEntrySummary; on: boolean }) {
  const scheme = useTheme().resolved.scheme;
  const suit = useSuitLook(props.entry);
  const scope = suit ? lookScope(suit, scheme) : undefined;
  return (
    <article
      className="mk-slide"
      data-on={props.on ? "" : undefined}
      aria-hidden={!props.on}
      {...scope}
      style={{ ...scope?.style, ...slideVars }}
    >
      <SlideWords entry={props.entry} />
      <div className="mk-slide-art">
        <Shot suit={suit} scheme={scheme} />
      </div>
    </article>
  );
}

function OtherSlide(props: { entry: MarketEntrySummary; on: boolean }) {
  const face = useBotLook(props.entry);
  const tint = face ? (botFaceColourVars(face) as CSSProperties) : undefined;
  return (
    <article
      className="mk-slide"
      data-on={props.on ? "" : undefined}
      aria-hidden={!props.on}
      data-type="tinted"
      style={tint}
    >
      <SlideWords entry={props.entry} />
      <div className="mk-slide-art" data-type={props.entry.type === "spade-bot" ? "bot" : "tool"}>
        {face ? (
          <>
            <span className="mk-floor" />
            <BotFace face={face} size={196} />
          </>
        ) : (
          <TypeMark type={props.entry.type} />
        )}
      </div>
    </article>
  );
}

function SlideWords(props: { entry: MarketEntrySummary }) {
  const nav = useMarketNav();
  const { entry } = props;
  return (
    <div className="mk-slide-words">
      <span className="mk-kind">{typeWord(entry.type)}</span>
      <h2 className="mk-display">{entry.title}</h2>
      <p className="mk-lead">{entry.line}</p>
      <EntryByline entry={entry} />
      <div className="mk-slide-actions">
        <SlideAction nav={nav} entry={entry} />
        <Button variant="secondary" size="lg" onClick={() => openEntry(nav, entry)}>
          See details
        </Button>
      </div>
    </div>
  );
}

function SlideAction(props: { nav: MarketNav; entry: MarketEntrySummary }) {
  const { nav, entry } = props;
  const suit = entry.type === "suit";
  const word = suit ? "Try it" : "Install";
  return (
    <Button
      variant="primary"
      size="lg"
      disabled={nav.offline || !entry.supported}
      title={nav.offline ? offlineTitle(word) : undefined}
      onClick={() =>
        suit
          ? nav.tryOn(entry, entry.title, publisherName(entry))
          : nav.push({
              kind: "review",
              entry: { source: entry.source, type: entry.type, name: entry.name },
              update: false,
            })
      }
    >
      {word}
    </Button>
  );
}
