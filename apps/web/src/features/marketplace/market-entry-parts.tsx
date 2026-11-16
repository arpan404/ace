import type { MarketEntryDetail, MarketEntrySummary } from "@ace/protocol/marketplace";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useTheme } from "@/theme/theme-provider.tsx";
import { useMarketSearch, type EntryKey } from "./market-api.ts";
import { Card, CardItem, Cards, EntryByline, Section, publisherName } from "./market-card.tsx";
import { dateText, entryAction, installBlock, sizeText } from "./market-model.ts";
import { Avatar, Verified } from "./market-marks.tsx";
import { offlineTitle, useMarketNav } from "./market-nav.ts";

/*
 * What every entry page shares: the line under its title (who, and whether ace reviewed it), its
 * one action, why it can't be installed, the facts at its side, its publisher and more from them.
 */

/** "Reviewed by ace" or "Not reviewed by ace"; nothing for ace's own. */
export function reviewedWords(entry: Pick<MarketEntrySummary, "byAce" | "reviewed">) {
  if (entry.byAce) return undefined;
  return entry.reviewed ? "Reviewed by ace" : "Not reviewed by ace";
}

export function EntrySub(props: { entry: MarketEntrySummary }) {
  const reviewed = reviewedWords(props.entry);
  return (
    <div className="mk-entry-sub">
      <EntryByline entry={props.entry} />
      {reviewed && (
        <>
          <span className="mk-dot">·</span>
          <span>{reviewed}</span>
        </>
      )}
    </div>
  );
}

/** Why this entry can't be installed, or that it was withdrawn and turned off here. */
export function EntryBlocked(props: { detail: MarketEntryDetail }) {
  const block = installBlock(props.detail);
  const installed = props.detail.installed;
  return (
    <>
      {block && <p className="mk-withdrawn-line">{block}</p>}
      {installed?.state === "withdrawn" && (
        <p className="mk-withdrawn-line">
          Withdrawn by its publisher and turned off
          {installed.reason ? `: ${installed.reason}` : "."}
        </p>
      )}
    </>
  );
}

/**
 * The entry's action: Install (to its review), Update (to the update's own review), or that it
 * is installed with a way to open it. Nothing when it can't be installed.
 */
export function InstallAction(props: {
  entry: EntryKey;
  detail: MarketEntryDetail;
  extra?: ReactNode;
}) {
  const nav = useMarketNav();
  const navigate = useNavigate();
  const action = entryAction(props.detail);
  const title = props.detail.summary.title;
  if (action === "none") return props.extra ?? null;
  if (action === "installed") {
    const target = props.detail.installed?.target;
    const bot = props.detail.summary.type === "spade-bot" && target;
    return (
      <>
        <span className="mk-state-word">Installed</span>
        {props.extra}
        {bot && (
          <Button
            variant="secondary"
            size="lg"
            onClick={() => {
              nav.close();
              void navigate({ to: "/spade/$agentId", params: { agentId: target } });
            }}
          >
            Open {title}
          </Button>
        )}
      </>
    );
  }
  const update = action === "update";
  const word = update ? "Update" : "Install";
  return (
    <>
      {props.extra}
      <Button
        variant="primary"
        size="lg"
        disabled={nav.offline}
        title={nav.offline ? offlineTitle(word) : undefined}
        onClick={() => nav.push({ kind: "review", entry: props.entry, update })}
      >
        {word}
      </Button>
    </>
  );
}

/** One fact: its name and value; false or undefined leaves it out. */
export type FactRow = readonly [string, ReactNode] | false | undefined;

/** Facts as a definition list. */
export function Facts(props: { rows: readonly FactRow[] }) {
  return (
    <dl className="mk-facts">
      {props.rows.map((row) =>
        row ? (
          <div key={row[0]} className="mk-fact">
            <dt>{row[0]}</dt>
            <dd>{row[1]}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

/** Version, published, size, downloads and where it comes from. */
export function versionFacts(detail: MarketEntryDetail): FactRow[] {
  const latest = detail.versions[0];
  const { summary, installed } = detail;
  const rows: FactRow[] = [["Version", latest?.version ?? summary.version ?? "—"]];
  if (latest) rows.push(["Published", dateText(latest.published)], ["Size", sizeText(latest.size)]);
  if (installed)
    rows.push([
      "Installed",
      installed.update ? `${installed.version}, ${installed.update} available` : installed.version,
    ]);
  rows.push(
    ["Downloads", summary.downloads.toLocaleString("en-US")],
    ["Source", summary.from?.replace(/^https:\/\//, "") ?? "market.acehq.dev"],
  );
  return rows;
}

/** The publisher, under the facts. */
export function PublisherMini(props: { entry: MarketEntrySummary }) {
  const name = publisherName(props.entry);
  if (!name) return null;
  const verified = props.entry.byAce || Reflect.get(props.entry, "verified") === true;
  return (
    <div className="mk-publisher-mini">
      <Avatar name={name} size={40} ace={props.entry.byAce} />
      <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span className="mk-pub-name">
          {name}
          {verified && <Verified />}
        </span>
        <span className="mk-meta">{props.entry.from ? "Git catalog" : "Publisher"}</span>
      </span>
    </div>
  );
}

/** Up to four more entries by the same publisher. */
export function MoreFrom(props: { entry: MarketEntrySummary; title?: string | undefined }) {
  const found = useMarketSearch({ query: "" });
  const { entry } = props;
  const by = entry.byAce ? "ace" : entry.publisher?.id;
  const more = (found.data?.entries ?? [])
    .filter(
      (other) =>
        (other.byAce ? "ace" : other.publisher?.id) === by &&
        !(other.type === entry.type && other.name === entry.name),
    )
    .slice(0, 4);
  if (!by || !more.length) return null;
  const title = props.title ?? `More from ${publisherName(entry) ?? ""}`;
  return (
    <Section title={title}>
      <Cards cols={4} shelf label={title}>
        {more.map((other) => (
          <CardItem key={`${other.type}/${other.name}`}>
            <Card entry={other} />
          </CardItem>
        ))}
      </Cards>
    </Section>
  );
}

/** Whether the Suit installed as `target` is the one this device wears. */
export function useWearing(target: string | undefined): { wearing: boolean; wear(): void } {
  const theme = useTheme();
  return {
    wearing: target !== undefined && theme.appearance.suit === target,
    wear: () => {
      if (target) theme.update({ suit: target });
    },
  };
}
