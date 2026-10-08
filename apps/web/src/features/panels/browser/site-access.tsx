import type { BrowserEvaluateGrant, BrowserOriginGrant } from "@ace/protocol";
import { addressHost } from "@ace/ui-core";
import { GlobeSimpleIcon, LockSimpleIcon, LockSimpleOpenIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { reason, type BrowserFeatures } from "./use-browser-features.ts";

interface Grants {
  sites: readonly BrowserOriginGrant[];
  scripts: readonly BrowserEvaluateGrant[];
}

/** How the page's connection reads: secure (https), not secure (http elsewhere), or local. */
export function connection(url: string | undefined): "secure" | "insecure" | "local" {
  if (!url) return "local";
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`);
    if (parsed.protocol === "https:") return "secure";
    const host = parsed.hostname;
    return host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host.endsWith(".localhost")
      ? "local"
      : "insecure";
  } catch {
    return "local";
  }
}

const glyphs = {
  secure: { icon: LockSimpleIcon, label: "Secure connection", tone: "text-subtle-foreground" },
  insecure: { icon: LockSimpleOpenIcon, label: "Not secure", tone: "text-status-needs-you" },
  local: { icon: GlobeSimpleIcon, label: "Local page", tone: "text-subtle-foreground" },
} as const;

/**
 * The page's security mark at the address's start, which opens the sites this thread's agents
 * may open and where they may run read-only scripts, each with Revoke. Read when opened;
 * revoking also ends any matching request still waiting.
 */
export function SiteAccess(props: {
  threadId: string;
  browser: BrowserFeatures;
  url: string | undefined;
}) {
  const { threadId, browser } = props;
  const [grants, setGrants] = useState<Grants>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const kind = connection(props.url);
  const glyph = glyphs[kind];
  const read = () => {
    setFailure(undefined);
    Promise.all([browser.origins.list(threadId), browser.features.evaluateGrants(threadId)]).then(
      ([sites, scripts]) => setGrants({ sites, scripts }),
      (error: unknown) => setFailure(reason(error)),
    );
  };
  const revoke = (run: () => Promise<unknown>) => {
    setBusy(true);
    run()
      .then(read, (error: unknown) => setFailure(reason(error)))
      .finally(() => setBusy(false));
  };
  return (
    <Popover onOpenChange={(open) => open && read()}>
      <Tip label={`${glyph.label} · Site access`}>
        <PopoverTrigger
          aria-label="Site access"
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full focus-ring hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
            glyph.tone,
          )}
        >
          <glyph.icon aria-hidden size={14} />
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="start" className="flex w-80 flex-col gap-2">
        <PopoverTitle className="text-ui font-medium">Site access in this thread</PopoverTitle>
        {failure && <p className="text-sm text-status-failed">{failure}</p>}
        {grants && (
          <>
            <GrantList
              label="Sites agents may open"
              empty="No sites yet. Agents ask before opening a new one."
              rows={grants.sites.map((grant) => ({
                key: grant.origin,
                name: addressHost(grant.origin) ?? grant.origin,
                detail: grant.scope === "page" ? "This page only" : "This thread",
                action: `Revoke ${addressHost(grant.origin) ?? grant.origin}`,
                revoke: () => revoke(() => browser.origins.revoke(threadId, grant.origin)),
              }))}
              busy={busy}
            />
            <GrantList
              label="Read-only scripts"
              empty="No site may run scripts without asking."
              rows={grants.scripts.map((grant) => ({
                key: grant.origin,
                name: addressHost(grant.origin) ?? grant.origin,
                detail: "Read only · this thread",
                action: `Revoke scripts on ${addressHost(grant.origin) ?? grant.origin}`,
                revoke: () =>
                  revoke(() => browser.features.revokeEvaluateGrant(threadId, grant.origin)),
              }))}
              busy={busy}
            />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function GrantList(props: {
  label: string;
  empty: string;
  busy: boolean;
  rows: { key: string; name: string; detail: string; action: string; revoke(): void }[];
}) {
  return (
    <section aria-label={props.label}>
      <h3 className="text-xs font-medium text-subtle-foreground">{props.label}</h3>
      {props.rows.length === 0 ? (
        <EmptyState variant="inline" title={props.empty} className="px-0 pt-1" />
      ) : (
        <ul className="flex flex-col">
          {props.rows.map((row) => (
            <li key={row.key} className="flex items-center gap-2 border-b py-1.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui">{row.name}</p>
                <p className="truncate text-xs text-subtle-foreground">{row.detail}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={row.action}
                disabled={props.busy}
                onClick={row.revoke}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
