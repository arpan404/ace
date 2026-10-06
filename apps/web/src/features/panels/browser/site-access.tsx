import type { BrowserEvaluateGrant, BrowserOriginGrant } from "@ace/protocol";
import { addressHost } from "@ace/ui-core";
import { ShieldCheckIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { reason, type BrowserFeatures } from "./use-browser-features.ts";

interface Grants {
  sites: readonly BrowserOriginGrant[];
  scripts: readonly BrowserEvaluateGrant[];
}

/**
 * The sites this thread's agents may open, and where they may run read-only scripts, each with
 * Revoke. Read when opened; revoking also ends any matching request still waiting.
 */
export function SiteAccess(props: { threadId: string; browser: BrowserFeatures }) {
  const { threadId, browser } = props;
  const [grants, setGrants] = useState<Grants>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
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
      <Tip label="Site access">
        <PopoverTrigger
          aria-label="Site access"
          className="grid size-7 place-items-center rounded-sm text-muted-foreground focus-ring hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
        >
          <ShieldCheckIcon aria-hidden size={16} />
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="flex w-80 flex-col gap-2">
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
