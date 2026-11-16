import type { MarketEntrySummary } from "@ace/protocol/marketplace";
import type { SuitPage } from "@ace/protocol/suit-parts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LoadingRegion, SkeletonText } from "@/components/ui/skeleton.tsx";
import { Screen } from "@/features/shell/index.ts";
import { part } from "@/lib/suit-part.ts";
import { metaLine } from "./market-model.ts";
import { useMarketPlace } from "./market-place.ts";

/*
 * The Marketplace's main column: a page with its title and a list of entries as hairline rows,
 * the way History lists threads: title, one line, then the type and publisher in meta ink.
 */

// A hairline row whose hover wash overhangs the page's gutter, so its text sits on the edge.
export const marketRow =
  "-mx-2.5 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** A page in the Marketplace's main column: its title, then its content in the reading column. */
export function MarketPage(props: {
  title: string;
  page?: SuitPage;
  variant?: string | undefined;
  /** The title row's right: the entry's one action. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Screen
      page={props.page ?? "marketplace"}
      pageVariant={props.variant}
      title="Marketplace"
      namedByPanel
    >
      <div className="h-full overflow-auto">
        <div
          {...part("page-body")}
          className="mx-auto flex w-full max-w-[720px] flex-col px-(--forge-gutter) pt-6 pb-20"
        >
          <div {...part("page-header")} className="flex min-w-0 items-start gap-4">
            <h2
              {...part("page-title")}
              className="min-w-0 flex-1 text-xl font-semibold text-foreground"
            >
              {props.title}
            </h2>
            {props.action}
          </div>
          {props.children}
        </div>
      </div>
    </Screen>
  );
}

/** Entries as rows; each opens its page. */
export function EntryList(props: { label: string; entries: readonly MarketEntrySummary[] }) {
  return (
    <ul aria-label={props.label} {...part("list", undefined, "market")} className="mt-4">
      {props.entries.map((entry) => (
        <EntryRow key={`${entry.source}/${entry.type}/${entry.name}`} entry={entry} />
      ))}
    </ul>
  );
}

function EntryRow(props: { entry: MarketEntrySummary }) {
  const { entry } = props;
  const place = useMarketPlace();
  return (
    <li {...part("list-row", undefined, entry.type)} className="border-b border-border">
      <Link
        to="/marketplace/$source/$type/$name"
        params={{ source: entry.source, type: entry.type, name: entry.name }}
        search={place.filterSearch}
        data-view-row=""
        className={marketRow}
      >
        <span className="min-w-0">
          <span className="block truncate text-ui font-medium text-foreground">{entry.title}</span>
          {entry.line && (
            <span className="mt-0.5 block truncate text-ui text-muted-foreground">
              {entry.line}
            </span>
          )}
          <span className="mt-0.5 block truncate text-meta text-subtle-foreground">
            {metaLine(entry)}
            {!entry.reviewed && !entry.byAce && " · Not reviewed by ace"}
          </span>
        </span>
        {!entry.supported && (
          <span className="text-meta text-subtle-foreground">Needs a newer ace</span>
        )}
      </Link>
    </li>
  );
}

/** One quiet line where rows would be: nothing found, or a list that couldn't be read. */
export function Quiet(props: { children: ReactNode }) {
  return <p className="mt-4 text-ui text-muted-foreground">{props.children}</p>;
}

export function ListSkeleton() {
  return (
    <LoadingRegion label="marketplace" className="mt-4 block">
      <SkeletonText lines={4} />
    </LoadingRegion>
  );
}
