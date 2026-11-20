import { CaretLeftIcon } from "@ace/icons";
import { Fragment } from "react";
import { part } from "@/lib/suit-part.ts";
import type { MarketPage as Page, MarketView } from "./market-address.ts";
import { useMarketEntry } from "./market-api.ts";
import { AppsPage } from "./market-apps.tsx";
import { CatalogsPage } from "./market-catalogs.tsx";
import { BotsPage, DiscoverPage, LooksPage, SearchResults, ToolsPage } from "./market-discover.tsx";
import { EntryPage } from "./market-entry.tsx";
import { InstalledPage } from "./market-installed.tsx";
import { useMarketNav } from "./market-nav.ts";
import { ManageCrumb, ManagePage } from "./market-manage.tsx";
import { ProfilePage } from "./market-profile.tsx";
import { PublishPage } from "./market-publish.tsx";
import { CollectionPage, PublisherPage, usePageTitle } from "./market-publisher.tsx";
import { ReviewPage } from "./market-review.tsx";

/*
 * What one layer of the modal's stack shows: the place, or the page on top of it with the crumb
 * trail back. A search shows its results over whichever place it was typed in.
 */

const placeNames = {
  discover: "Discover",
  looks: "Looks",
  bots: "Bots",
  tools: "Tools",
  apps: "Apps",
  installed: "Installed",
} as const;

function EntryCrumb(props: { page: Extract<Page, { kind: "entry" | "review" }> }) {
  const title = useMarketEntry(props.page.entry).data?.entry.summary.title ?? props.page.entry.name;
  return <>{props.page.kind === "review" ? (props.page.update ? "Update" : "Review") : title}</>;
}

function NamedCrumb(props: { kind: "publisher" | "collection"; id: string }) {
  return <>{usePageTitle(props.kind, props.id)}</>;
}

/** A page's own key in the trail: its kind and what it shows. */
function crumbKey(page: Page): string {
  switch (page.kind) {
    case "entry":
    case "review":
      return `${page.kind}:${page.entry.source}/${page.entry.type}/${page.entry.name}`;
    case "publisher":
      return `publisher:${page.handle}`;
    case "collection":
      return `collection:${page.id}`;
    case "manage":
      return `manage:${page.type}/${page.name}`;
    default:
      return page.kind;
  }
}

function crumbOf(page: Page) {
  switch (page.kind) {
    case "entry":
    case "review":
      return <EntryCrumb page={page} />;
    case "publisher":
      return <NamedCrumb kind="publisher" id={page.handle} />;
    case "collection":
      return <NamedCrumb kind="collection" id={page.id} />;
    case "profile":
      return "Your profile";
    case "publish":
      return "Publish";
    case "manage":
      return <ManageCrumb type={page.type} name={page.name} />;
    case "catalogs":
      return "Catalogs";
  }
}

const widthOf = (page: Page | undefined) =>
  page?.kind === "review" || page?.kind === "publish"
    ? "form"
    : page?.kind === "profile" || page?.kind === "catalogs" || page?.kind === "manage"
      ? "read"
      : undefined;

function Crumbs(props: { view: MarketView }) {
  const nav = useMarketNav();
  const { pages } = props.view;
  return (
    <nav aria-label="Back" className="mk-crumbs mk-inner" data-width={widthOf(pages.at(-1))}>
      <button type="button" onClick={() => nav.popTo(0)}>
        <CaretLeftIcon aria-hidden size={14} />
        {placeNames[props.view.place]}
      </button>
      {pages.map((page, at) => (
        <Fragment key={crumbKey(page)}>
          <span className="mk-sep">/</span>
          {at < pages.length - 1 ? (
            <button type="button" onClick={() => nav.popTo(at + 1)}>
              {crumbOf(page)}
            </button>
          ) : (
            <span aria-current="page">{crumbOf(page)}</span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

function TopPage(props: { page: Page }) {
  const { page } = props;
  switch (page.kind) {
    case "entry":
      return <EntryPage entry={page.entry} />;
    case "review":
      return <ReviewPage entry={page.entry} update={page.update} rollback={page.rollback} />;
    case "publisher":
      return <PublisherPage handle={page.handle} />;
    case "collection":
      return <CollectionPage id={page.id} />;
    case "profile":
      return <ProfilePage />;
    case "publish":
      return <PublishPage draft={page.draft} />;
    case "manage":
      return <ManagePage type={page.type} name={page.name} />;
    case "catalogs":
      return <CatalogsPage />;
  }
}

function Place(props: { view: MarketView; query: string }) {
  const query = props.query.trim();
  switch (props.view.place) {
    case "discover":
      return <DiscoverPage query={query} />;
    case "looks":
      return <LooksPage query={query} />;
    case "bots":
      return <BotsPage query={query} />;
    case "tools":
      return <ToolsPage query={query} />;
    case "apps":
      return query ? <SearchResults query={query} /> : <AppsPage />;
    case "installed":
      return query ? <SearchResults query={query} /> : <InstalledPage />;
  }
}

/** One layer of the stack: the place, or its top page under the crumbs. */
export function MarketLayer(props: { view: MarketView; query: string }) {
  const top = props.view.pages.at(-1);
  return (
    <div {...part("page")} data-page={top ? "market-entry" : "marketplace"}>
      {top ? (
        <>
          <Crumbs view={props.view} />
          <TopPage page={top} />
        </>
      ) : (
        <Place view={props.view} query={props.query} />
      )}
    </div>
  );
}
