import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, buttonLook } from "@/components/ui/button.tsx";
import { part } from "@/lib/suit-part.ts";
import { useMarketHome, useMarketInstalled, useMarketSearch, useRemove } from "./market-api.ts";
import { failureSentence, installedRows, shownBy, typeWord } from "./market-model.ts";
import { useMarketPlace } from "./market-place.ts";
import { EntryList, ListSkeleton, MarketPage, Quiet, marketRow } from "./market-rows.tsx";

/** Featured when nothing is searched; otherwise what the search finds, under the filter. */
export function MarketHomeScreen() {
  const place = useMarketPlace();
  if (place.query.trim()) return <SearchResults query={place.query.trim()} />;
  return <Featured />;
}

function Featured() {
  const place = useMarketPlace();
  const home = useMarketHome();
  const featured = home.data?.featured.filter((entry) => shownBy(place.filter, entry.type));
  return (
    <MarketPage title="Featured">
      {home.isError && !home.data ? (
        <Quiet>{failureSentence(home.error, "read")}</Quiet>
      ) : !featured ? (
        <ListSkeleton />
      ) : !featured.length ? (
        <Quiet>Nothing featured here yet.</Quiet>
      ) : (
        <EntryList label="Featured" entries={featured} />
      )}
    </MarketPage>
  );
}

function SearchResults(props: { query: string }) {
  const place = useMarketPlace();
  const found = useMarketSearch({ query: props.query, filter: place.filter });
  return (
    <MarketPage title="Search">
      {found.isError && !found.data ? (
        <Quiet>{failureSentence(found.error, "read")}</Quiet>
      ) : !found.data ? (
        <ListSkeleton />
      ) : !found.data.entries.length ? (
        <Quiet>Nothing matches “{props.query}”.</Quiet>
      ) : (
        <EntryList label="Results" entries={found.data.entries} />
      )}
    </MarketPage>
  );
}

export function MarketCategoryScreen(props: { category: string }) {
  const place = useMarketPlace();
  const home = useMarketHome();
  const title = home.data?.categories.find((category) => category.id === props.category)?.title;
  const found = useMarketSearch({ query: "", filter: place.filter, category: props.category });
  // Only reviewed entries are listed under a category (ADR 0168 §11).
  const entries = found.data?.entries.filter((entry) => entry.reviewed);
  return (
    <MarketPage title={title ?? "Category"}>
      {found.isError && !found.data ? (
        <Quiet>{failureSentence(found.error, "read")}</Quiet>
      ) : !entries ? (
        <ListSkeleton />
      ) : !entries.length ? (
        <Quiet>Nothing here yet.</Quiet>
      ) : (
        <EntryList label={title ?? "Category"} entries={entries} />
      )}
    </MarketPage>
  );
}

/** Everything installed from the marketplace, each with Remove; updates first. */
export function MarketInstalledScreen() {
  return <InstalledList updatesOnly={false} />;
}

/** Installed entries with a newer version; each opens its own review. Nothing applies alone. */
export function MarketUpdatesScreen() {
  return <InstalledList updatesOnly />;
}

function InstalledList(props: { updatesOnly: boolean }) {
  const place = useMarketPlace();
  const installed = useMarketInstalled();
  const remove = useRemove();
  const [failed, setFailed] = useState<string>();
  const rows = installedRows(installed.data?.installed ?? [], place.filter).filter(
    (item) => !props.updatesOnly || item.update,
  );
  const title = props.updatesOnly ? "Updates" : "Installed";
  return (
    <MarketPage title={title}>
      {failed && (
        <p role="alert" className="mt-2 text-ui text-destructive">
          {failed}
        </p>
      )}
      {installed.isError && !installed.data ? (
        <Quiet>{failureSentence(installed.error, "read")}</Quiet>
      ) : !installed.data ? (
        <ListSkeleton />
      ) : !rows.length ? (
        <Quiet>{props.updatesOnly ? "Everything is up to date." : "Nothing installed yet."}</Quiet>
      ) : (
        <ul aria-label={title} {...part("list", undefined, "market")} className="mt-4">
          {rows.map((item) => (
            <li
              key={`${item.type}/${item.name}`}
              {...part("list-row", item.state === "on" ? undefined : "disabled", item.type)}
              className="border-b border-border"
            >
              <div className={marketRow}>
                <span className="min-w-0">
                  <Link
                    to="/marketplace/$source/$type/$name"
                    params={{ source: item.source, type: item.type, name: item.name }}
                    search={place.filterSearch}
                    {...part("link", undefined, "row")}
                    className="block truncate text-ui font-medium text-foreground hover:underline"
                  >
                    {item.title}
                  </Link>
                  <span className="mt-0.5 block truncate text-meta text-subtle-foreground">
                    {typeWord(item.type)} · Version {item.version}
                    {item.update && ` · ${item.update} available`}
                    {item.state === "withdrawn" && " · Withdrawn by its publisher, turned off"}
                    {item.state === "off" && " · Off"}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {item.update && (
                    <Link
                      to="/marketplace/$source/$type/$name/review"
                      params={{ source: item.source, type: item.type, name: item.name }}
                      search={{ ...place.filterSearch, update: 1 }}
                      {...buttonLook(
                        { variant: "secondary", size: "sm" },
                        "inline-flex items-center",
                      )}
                    >
                      Review update
                    </Link>
                  )}
                  {/* Bots made from a recipe are the person's: removed like any bot, in Spade. */}
                  {item.type !== "spade-bot" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${item.title}`}
                      disabled={remove.isPending}
                      onClick={() => {
                        setFailed(undefined);
                        remove.mutate(item, {
                          onError: (error) => setFailed(failureSentence(error, "remove")),
                        });
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </MarketPage>
  );
}
