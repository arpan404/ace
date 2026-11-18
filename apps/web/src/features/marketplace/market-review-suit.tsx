import type { MarketReviewItem } from "@ace/protocol/marketplace";
import type { SuitDetail } from "@ace/protocol/suits";
import { useState, type ReactNode } from "react";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { ReviewFiles } from "./market-review-items.tsx";
import { SuitPicture } from "./market-stage.tsx";

/*
 * The readable half of a review: a Suit's look in each scheme it has, side by side, and every
 * entry's files behind Show files, the list first, then anything raw folded with them.
 */

const schemeWords = { light: "Light", dark: "Dark" } as const;

export function SuitLooks(props: { suit: SuitDetail | undefined }) {
  const { suit } = props;
  const schemes = suit?.summary.schemes ?? [];
  if (!suit || !schemes.length) return null;
  return (
    <div className="mk-review-looks" aria-label="How it looks">
      {(["light", "dark"] as const)
        .filter((scheme) => schemes.includes(scheme))
        .map((scheme) => (
          <figure key={scheme}>
            <Look suit={suit} scheme={scheme} />
            <figcaption className="mk-meta">
              {schemes.length === 1 ? `${schemeWords[scheme]} only` : schemeWords[scheme]}
            </figcaption>
          </figure>
        ))}
    </div>
  );
}

/** Its own thumbnail for the scheme when the library serves one, else its window in the palette. */
function Look(props: { suit: SuitDetail; scheme: "light" | "dark" }) {
  const path = props.suit.manifest.thumbnail?.[props.scheme];
  const url = path ? props.suit.assets[path] : undefined;
  return url ? (
    <div className="mk-stage" data-type="picture" aria-hidden>
      <img src={url} alt="" className="mk-stage-picture" draggable={false} />
    </div>
  ) : (
    <SuitPicture suit={props.suit} scheme={props.scheme} />
  );
}

/** The content hash and file list, then whatever else is folded with them, until asked for. */
export function ShowFiles(props: {
  items: readonly MarketReviewItem[];
  hash: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      className="mk-show-files"
      summary={open ? "Hide files" : "Show files"}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <p className="mk-meta mk-hash">
        Content hash{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {`sha256:${props.hash.slice(0, 4)}…${props.hash.slice(-4)}`}
        </span>
      </p>
      <ReviewFiles items={props.items} />
      {props.children}
    </Disclosure>
  );
}
