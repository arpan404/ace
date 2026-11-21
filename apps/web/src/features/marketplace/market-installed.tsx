import type { MarketInstalled } from "@ace/protocol/marketplace";
import type { CSSProperties } from "react";
import { Button } from "@/components/ui/button.tsx";
import { part } from "@/lib/suit-part.ts";
import { useMarketInstalled, useRemove, useTurnOn } from "./market-api.ts";
import { BotsApproval, waitsForBots } from "./market-bots-approval.tsx";
import { Empty } from "./market-card.tsx";
import { failureSentence, typeWord } from "./market-model.ts";
import { offlineTitle, useMarketNav } from "./market-nav.ts";
import { Stage } from "./market-stage.tsx";
import { useMarketApps } from "./market-apps.tsx";
import { isYours } from "./market-app-model.ts";
import { AppRow, Shelf, StoreRows } from "./market-store-row.tsx";

/*
 * Installed: everything this machine installed from the marketplace, updates first, and the same
 * list narrowed to Updates. An update is never applied on its own: Update opens its review, and
 * only that review's Install replaces the version in use. A withdrawn entry stays off until the
 * person turns it on or removes it. Each bot made from a bot package is its own row; an update
 * accepted while its bot works shows the version running and says the new one waits.
 */

/** Installed entries with an update first, then by name. */
export function installedOrder(installed: readonly MarketInstalled[]): MarketInstalled[] {
  return installed.toSorted(
    (a, b) => Number(!!b.update) - Number(!!a.update) || a.title.localeCompare(b.title),
  );
}

/** An update the person accepted that waits for the bot's turn isn't offered again. */
const offered = (item: MarketInstalled) => item.update && item.update !== item.held?.version;

const row = (item: MarketInstalled) => (
  <InstalledRow key={`${item.type}/${item.name}/${item.target ?? ""}`} item={item} />
);

/**
 * Installed, in one place: what has an update first (each update opens its own short review),
 * then everything else installed here, then the person's apps. Nothing hides behind a filter.
 */
export function InstalledPage() {
  const nav = useMarketNav();
  const read = useMarketInstalled();
  const apps = useMarketApps();
  const all = installedOrder(read.data?.installed ?? []);
  const updates = all.filter(offered);
  const rest = all.filter((item) => !offered(item));
  const yours = apps?.filter(isYours) ?? [];
  if (read.isError && !read.data) return <Empty title={failureSentence(read.error, "read")} />;
  if (!read.data) return null;
  return (
    <div className="mk-inner" data-width="read">
      {all.length === 0 ? (
        <Shelf title="Installed">
          <p className="st-line">What you get from the marketplace shows here.</p>
        </Shelf>
      ) : (
        <>
          <Shelf title={updates.length === 1 ? "1 update" : `${updates.length || "No"} updates`}>
            {updates.length ? (
              <ul className="mk-rows" aria-label="Updates">
                {updates.map(row)}
              </ul>
            ) : (
              <p className="st-line">Everything is up to date. ace checks once a day.</p>
            )}
          </Shelf>
          {rest.length > 0 && (
            <Shelf title="Installed">
              <ul className="mk-rows" aria-label="Installed">
                {rest.map(row)}
              </ul>
            </Shelf>
          )}
        </>
      )}
      {yours.length > 0 && (
        <Shelf title="Your apps" all={() => nav.go("apps")}>
          <StoreRows label="Your apps" cols={2}>
            {yours.map((app) => (
              <AppRow key={app.id} app={app} />
            ))}
          </StoreRows>
        </Shelf>
      )}
      <div className="st-section">
        <button
          type="button"
          {...part("link")}
          className="st-all"
          onClick={() => nav.push({ kind: "catalogs" })}
        >
          Catalogs
        </button>
      </div>
    </div>
  );
}

function InstalledRow(props: { item: MarketInstalled }) {
  const nav = useMarketNav();
  const remove = useRemove();
  const turnOn = useTurnOn();
  const { item } = props;
  const key = { source: item.source, type: item.type, name: item.name };
  // A bot package's update or rollback moves its own bot.
  const bot = item.type === "spade-bot" && item.target ? { bot: item.target } : {};
  // An update the person accepted that waits for the bot's turn isn't offered again.
  const update = item.update && item.update !== item.held?.version ? item.update : undefined;
  const version = update ? `${item.version} → ${update}` : item.version;
  const busy = remove.isPending || turnOn.isPending;
  // A linked bot goes back to the version it had before, from the copy kept here (ADR 0200).
  const rollBack =
    item.linked && item.previous ? (
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Roll back ${item.title} to ${item.previous.version}`}
        disabled={busy}
        onClick={() =>
          nav.push({ kind: "review", entry: key, update: true, rollback: true, ...bot })
        }
      >
        Roll back
      </Button>
    ) : undefined;
  const failed = remove.error ?? turnOn.error;
  return (
    <li {...part("list-row", undefined, "market-installed")} className="mk-row">
      <button
        type="button"
        aria-label={item.title}
        style={{ display: "contents" }}
        onClick={() => nav.push({ kind: "entry", entry: key })}
      >
        <span
          className="st-icon"
          style={{ "--st-icon": "40px", "--st-icon-radius": "10px" } as CSSProperties}
        >
          <Stage entry={key} size="small" />
        </span>
      </button>
      <span className="mk-words">
        <span className="mk-name">{item.title}</span>
        {item.state === "withdrawn" && (
          <span className="mk-withdrawn-line">
            Withdrawn by its publisher{item.reason ? `: ${item.reason}` : "."}
          </span>
        )}
        {failed && <span className="mk-withdrawn-line">{failureSentence(failed, "remove")}</span>}
        {item.held && (
          <span className="mk-meta">Update to {item.held.version} waits for its turn</span>
        )}
        {waitsForBots(item) && <BotsApproval item={item} />}
        <span className="mk-meta">
          {typeWord(item.type)} ·{" "}
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{version}</span>
        </span>
      </span>
      <span className="mk-actions">
        {item.state === "withdrawn" ? (
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove.mutate(item)}>
              Remove
            </Button>
            {rollBack}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => turnOn.mutate(item)}
            >
              {item.linked ? "Resume" : "Turn on"}
            </Button>
          </>
        ) : update ? (
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Update ${item.title}`}
            disabled={nav.offline}
            title={nav.offline ? offlineTitle("Update") : undefined}
            onClick={() => nav.push({ kind: "review", entry: key, update: true, ...bot })}
          >
            Update
          </Button>
        ) : rollBack ? (
          rollBack
        ) : (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${item.title}`}
            disabled={busy}
            onClick={() => remove.mutate(item)}
          >
            Remove
          </Button>
        )}
      </span>
    </li>
  );
}
