import { GlobeSimpleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import type { SuggestedSite } from "./use-suggested.ts";

/** A site's favicon on a quiet plate, or a globe when it has none (or it fails to load). */
function SiteIcon(props: { src?: string | undefined }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="grid size-11 place-items-center rounded-lg border border-border bg-background">
      {props.src && !broken ? (
        <img
          src={props.src}
          alt=""
          width={24}
          height={24}
          draggable={false}
          onError={() => setBroken(true)}
          className="size-6 rounded-xs object-contain"
        />
      ) : (
        <Icon icon={GlobeSimpleIcon} size={20} className="text-muted-foreground" />
      )}
    </span>
  );
}

/**
 * The new tab's Suggested row: the thread's local dev servers first, then pages it visited, as
 * favicon tiles that open where they belong (a dev server in Preview, a page in the Browser).
 */
export function Suggested(props: {
  sites: readonly SuggestedSite[];
  onOpen(site: SuggestedSite): void;
}) {
  if (props.sites.length === 0) return null;
  return (
    <section aria-labelledby="launcher-suggested" className="mt-8">
      <h2 id="launcher-suggested" className="px-1 text-sm font-medium text-foreground">
        Suggested
      </h2>
      <ul
        aria-label="Suggested"
        className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1"
      >
        {props.sites.map((site) => (
          <li key={site.port === undefined ? site.url : `port:${site.port}`} className="min-w-0">
            <button
              type="button"
              title={site.url}
              aria-label={`${site.title} · ${site.detail}`}
              onClick={() => props.onOpen(site)}
              className={cn(
                "focus-ring flex w-full min-w-0 flex-col items-center gap-2 rounded-lg px-2 pt-3 pb-2.5 text-center",
                "transition-colors duration-(--motion-fast) hover:bg-fill",
              )}
            >
              <SiteIcon src={site.iconUrl} />
              <span className="flex w-full min-w-0 flex-col">
                <span className="truncate text-ui text-foreground">{site.title}</span>
                <span className="truncate text-xs text-muted-foreground">{site.detail}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
