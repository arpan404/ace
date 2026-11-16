import { ArrowsClockwiseIcon, BookOpenIcon, DownloadSimpleIcon, StarIcon } from "@ace/icons";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { IconGlyph } from "@/components/icon.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { PanelRowBody, PanelSection, panelRow } from "@/components/ui/panel.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { useMarketHome, useMarketSources } from "./market-api.ts";
import { filterOptions, readAtText, type MarketFilter } from "./market-model.ts";
import { useMarketPlace } from "./market-place.ts";

/**
 * The Marketplace's panel (ADR 0168 §12): its title with the type filter in words, its search,
 * then Featured, the categories, Installed, Updates and Catalogs. With a listing that couldn't be
 * read again, one line says when the one on screen was read.
 */
export function MarketSidebar() {
  const place = useMarketPlace();
  const navigate = useNavigate();
  const home = useMarketHome();
  const sources = useMarketSources();
  const now = useNow();
  const stale = sources.data?.sources.filter((source) => source.enabled && source.problem);
  const readAt = stale?.length
    ? Math.min(...stale.map((source) => source.readAt ?? now))
    : undefined;
  const offline = home.isError || sources.isError || readAt !== undefined;
  const lastRead = readAt ?? sources.data?.sources[0]?.readAt;
  return (
    <ViewSidebar
      title="Marketplace"
      actions={
        <FilterMenu<MarketFilter>
          label="Show"
          value={place.filter}
          options={filterOptions}
          onValueChange={place.setFilter}
        />
      }
      search={{
        label: "Search marketplace",
        query: place.query,
        onQuery: (query) =>
          void navigate({
            to: "/marketplace",
            search: { ...(query ? { q: query } : {}), ...place.filterSearch },
            replace: true,
          }),
      }}
    >
      {offline && lastRead !== undefined && (
        <p className="px-2.5 pt-1 pb-2 text-ui text-subtle-foreground">
          Offline. Last read at {readAtText(lastRead, now)}.
        </p>
      )}
      <nav aria-label="Marketplace" className="flex flex-col">
        <ul className="flex flex-col gap-px">
          <Row to="/marketplace" icon={StarIcon} title="Featured" exact />
        </ul>
        {!!home.data?.categories.length && (
          <PanelSection label="Categories">
            {home.data.categories.map((category) => (
              <li key={category.id}>
                <Link
                  to="/marketplace/categories/$category"
                  params={{ category: category.id }}
                  search={place.filterSearch}
                  {...panelRow()}
                >
                  <PanelRowBody title={category.title} trailing={<Count n={category.entries} />} />
                </Link>
              </li>
            ))}
          </PanelSection>
        )}
        <ul className="mt-5 flex flex-col gap-px">
          <Row
            to="/marketplace/installed"
            icon={DownloadSimpleIcon}
            title="Installed"
            trailing={home.data?.installed || undefined}
          />
          <Row
            to="/marketplace/updates"
            icon={ArrowsClockwiseIcon}
            title="Updates"
            trailing={home.data?.updates || undefined}
          />
          <Row to="/marketplace/catalogs" icon={BookOpenIcon} title="Catalogs" />
        </ul>
      </nav>
    </ViewSidebar>
  );
}

function Row(props: {
  to: "/marketplace" | "/marketplace/installed" | "/marketplace/updates" | "/marketplace/catalogs";
  icon: IconGlyph;
  title: string;
  trailing?: number | undefined;
  exact?: boolean;
}) {
  const place = useMarketPlace();
  return (
    <li>
      <Link
        to={props.to}
        search={place.filterSearch}
        activeOptions={{ exact: props.exact ?? false, includeSearch: false }}
        {...panelRow()}
      >
        <PanelRowBody
          icon={props.icon}
          title={props.title}
          trailing={props.trailing ? <Count n={props.trailing} /> : undefined}
        />
      </Link>
    </li>
  );
}

function Count(props: { n: number }): ReactNode {
  return <span className="text-xs text-subtle-foreground tabular-nums">{props.n}</span>;
}
