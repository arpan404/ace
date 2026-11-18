import type { MarketInstalled } from "@ace/protocol/marketplace";
import { Button } from "@/components/ui/button.tsx";
import { part } from "@/lib/suit-part.ts";
import { useMarketInstalled, useRemove, useTurnOn } from "./market-api.ts";
import { Empty } from "./market-card.tsx";
import { failureSentence, typeWord } from "./market-model.ts";
import { offlineTitle, useMarketNav } from "./market-nav.ts";
import { Stage } from "./market-stage.tsx";

/*
 * Installed: everything this machine installed from the marketplace, updates first, and the same
 * list narrowed to Updates. An update is never applied on its own: Update opens its review, and
 * only that review's Install replaces the version in use. A withdrawn entry stays off until the
 * person turns it on or removes it.
 */

/** Installed entries with an update first, then by name. */
export function installedOrder(installed: readonly MarketInstalled[]): MarketInstalled[] {
  return installed.toSorted(
    (a, b) => Number(!!b.update) - Number(!!a.update) || a.title.localeCompare(b.title),
  );
}

export function InstalledPage() {
  const nav = useMarketNav();
  const read = useMarketInstalled();
  const all = read.data?.installed ?? [];
  const updates = all.filter((item) => item.update);
  const updatesOnly = nav.view.installed === "updates";
  const list = installedOrder(updatesOnly ? updates : all);
  return (
    <div className="mk-inner" data-width="read">
      <div className="mk-installed-head">
        <div
          {...part("tabs", undefined, "words")}
          className="mk-word-choice"
          role="group"
          aria-label="Show"
        >
          <button
            type="button"
            {...part("tab", !updatesOnly && "selected")}
            aria-pressed={!updatesOnly}
            onClick={() => nav.setInstalled("all")}
          >
            All <span style={{ color: "var(--mk-subtle)", fontWeight: 400 }}>{all.length}</span>
          </button>
          <button
            type="button"
            {...part("tab", updatesOnly && "selected")}
            aria-pressed={updatesOnly}
            onClick={() => nav.setInstalled("updates")}
          >
            Updates{" "}
            {updates.length > 0 && (
              <span style={{ color: "var(--mk-subtle)", fontWeight: 400 }}>{updates.length}</span>
            )}
          </button>
        </div>
        <button
          type="button"
          {...part("link")}
          className="mk-quiet"
          onClick={() => nav.push({ kind: "catalogs" })}
        >
          Catalogs
        </button>
      </div>
      {read.isError && !read.data ? (
        <Empty title={failureSentence(read.error, "read")} />
      ) : !read.data ? null : list.length ? (
        <ul className="mk-rows" aria-label={updatesOnly ? "Updates" : "Installed"}>
          {list.map((item) => (
            <InstalledRow key={`${item.type}/${item.name}`} item={item} />
          ))}
        </ul>
      ) : updatesOnly ? (
        <Empty title="Everything is up to date" line="ace checks for updates once a day." />
      ) : (
        <Empty
          title="Nothing installed yet"
          line="What you install from the marketplace shows here."
        />
      )}
    </div>
  );
}

function InstalledRow(props: { item: MarketInstalled }) {
  const nav = useMarketNav();
  const remove = useRemove();
  const turnOn = useTurnOn();
  const { item } = props;
  const key = { source: item.source, type: item.type, name: item.name };
  const version = item.update ? `${item.version} → ${item.update}` : item.version;
  const busy = remove.isPending || turnOn.isPending;
  const failed = remove.error ?? turnOn.error;
  return (
    <li {...part("list-row", undefined, "market-installed")} className="mk-row">
      <button
        type="button"
        aria-label={item.title}
        style={{ display: "contents" }}
        onClick={() => nav.push({ kind: "entry", entry: key })}
      >
        <Stage entry={key} size="small" />
      </button>
      <span className="mk-words">
        <span className="mk-name">{item.title}</span>
        {item.state === "withdrawn" && (
          <span className="mk-withdrawn-line">
            Withdrawn by its publisher{item.reason ? `: ${item.reason}` : "."}
          </span>
        )}
        {failed && <span className="mk-withdrawn-line">{failureSentence(failed, "remove")}</span>}
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
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => turnOn.mutate(item)}
            >
              Turn on
            </Button>
          </>
        ) : item.update ? (
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Update ${item.title}`}
            disabled={nav.offline}
            title={nav.offline ? offlineTitle("Update") : undefined}
            onClick={() => nav.push({ kind: "review", entry: key, update: true })}
          >
            Update
          </Button>
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
