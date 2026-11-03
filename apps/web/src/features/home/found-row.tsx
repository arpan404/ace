import { useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { createContext, use, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { panelRowLine } from "@/components/ui/panel.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useOpenHere } from "./thread-row.tsx";
import type { SearchHit } from "./use-panel-search.ts";

/** A panel search's hits for older threads the list hasn't loaded, by thread id. */
export const FoundHits = createContext<ReadonlyMap<string, SearchHit>>(new Map());

/**
 * A thread the daemon's search found that the list hasn't paged in: one line led by its
 * provider's mark (in the same 18px slot as a listed row's, so titles line up) and its title. A
 * settled chat's is dimmed (`dimmed`); attention is brightness alone, so the open one is in full
 * ink and never bold.
 */
export function FoundRow(props: { hit: SearchHit; dimmed?: boolean | undefined }) {
  const { hit } = props;
  const current = useOpenHere(hit.threadId, undefined);
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: hit.threadId }}
      aria-label={`${hit.threadTitle}. Settled`}
      data-row-focus=""
      draggable={false}
      className={cn(
        panelRowLine,
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        current ? "bg-active" : "hover:bg-hover",
        current || !props.dimmed ? "text-foreground" : "text-subtle-foreground",
      )}
    >
      <span className="flex w-[18px] shrink-0 items-center">
        <ProviderIcon
          provider={hit.provider}
          size={14}
          decorative
          className="text-foreground opacity-80"
        />
      </span>
      <span className="min-w-0 flex-1 truncate">{hit.threadTitle}</span>
    </Link>
  );
}

/** A listed thread's own row (`children`), or, for one only the search found, its found row. */
export function ListedOrFound(props: { id: string; children: ReactNode }) {
  const listed = useSidebarThread(props.id) !== undefined;
  const hit = use(FoundHits).get(props.id);
  return !listed && hit ? <FoundRow hit={hit} /> : props.children;
}
