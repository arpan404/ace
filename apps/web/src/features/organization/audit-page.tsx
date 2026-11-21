import { orgAllows } from "@ace/client/ace-org";
import type { AceOrgPortalIntent, AceOrgSpace } from "@ace/protocol/ace-org";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { openExternalWhenReady } from "@/boot/open-external.ts";
import {
  SettingList,
  SettingListItem,
  SettingNote,
  SettingRow,
  SettingSection,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useSpaceMachines } from "@/features/ace-account/index.ts";
import {
  orgFailure,
  readAuditLines,
  useOrgReadKey,
  usePortalLink,
} from "@/features/ace-org/index.ts";
import { readAuditExport } from "@/features/spade/index.ts";
import { saveDownload } from "@/lib/save-download.ts";

/** Newest entries the page lists; the export has them all. */
const shownEntries = 50;

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Settings › Organization › Audit log (ADR 0206 §4): each host keeps a signed, chained log of what
 * its shared bots did and who allowed it, read here from the host's own Spade; it exports as JSON
 * Lines for `ace org audit verify`, which checks it offline. The organization's copy in WorkOS is
 * exported and streamed from the Admin Portal.
 */
export function AuditPage(props: { org: AceOrgSpace }) {
  const hosts = useSpaceMachines().filter((machine) => machine.client !== undefined);
  const [picked, setPicked] = useState<string>();
  const host = hosts.find((machine) => machine.id === picked) ?? hosts[0];
  const key = useOrgReadKey(props.org.id, `audit:${host?.id ?? ""}`);
  const log = useQuery({
    queryKey: key,
    enabled: host?.client !== undefined,
    retry: false,
    queryFn: ({ signal }) =>
      host?.client ? readAuditExport(host.client, {}, signal) : Promise.resolve(""),
  });
  const read = log.data === undefined ? undefined : readAuditLines(log.data);
  const rows = read ? read.rows.slice(-shownEntries).toReversed() : [];
  const [error, setError] = useState("");
  return (
    <>
      <SettingSection
        label="Hosts' logs"
        anchor="org.audit"
        note="Every outward step of a shared bot, and the member who allowed it. Never message text."
        actions={
          hosts.length > 1 && host ? (
            <Select
              label="Host"
              value={host.id}
              options={hosts.map((machine) => ({ value: machine.id, label: machine.name }))}
              onValueChange={setPicked}
            />
          ) : undefined
        }
      >
        {!host && (
          <SettingNote>
            Open one of {props.org.name}'s hosts in this window to read its log.
          </SettingNote>
        )}
        {log.isLoading && <SettingNote>Reading {host?.name}'s log…</SettingNote>}
        {log.error && (
          <SettingNote role="alert">Couldn't read {host?.name}'s log. Try again.</SettingNote>
        )}
        {read && rows.length === 0 && <SettingNote>Nothing on record yet.</SettingNote>}
        {rows.length > 0 && (
          <SettingList aria-label={`${host?.name ?? "Host"}'s log`}>
            {rows.map((row) => (
              <SettingListItem key={row.seq} className="gap-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-ui font-medium text-foreground">
                    {row.title}
                    {row.targets ? ` · ${row.targets}` : ""}
                  </span>
                  <span className="truncate text-xs text-subtle-foreground">
                    {[row.actor, row.allowedBy && `allowed by ${row.allowedBy}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{when(row.at)}</span>
              </SettingListItem>
            ))}
          </SettingList>
        )}
        {read && host && (
          <SettingRow
            title="Export"
            description={`The whole log as JSON Lines, with its ${read.checkpoints} signed checkpoints.`}
            inline
          >
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setError("");
                const bytes = new TextEncoder().encode(log.data ?? "");
                void saveDownload(
                  `${props.org.name}-${host.name}-audit.jsonl`.replace(/[^\w.-]+/g, "-"),
                  (async function* () {
                    yield bytes;
                  })(),
                ).catch(() => setError("Couldn't save the export. Try again."));
              }}
            >
              Export
            </Button>
          </SettingRow>
        )}
        {read?.header && (
          <SettingRow
            title="Verify"
            description={
              <>
                On any machine with ace, run{" "}
                <code className="font-mono break-all">
                  ace org audit verify {"<file>"} --key {read.header.key || "<key>"}
                </code>
                . It checks every entry's chain and each checkpoint's signature, offline. Use the
                key {props.org.name} registered for the host, not one the file names.
              </>
            }
          />
        )}
        {error && (
          <SettingNote role="alert" className="text-destructive">
            {error}
          </SettingNote>
        )}
      </SettingSection>
      <WorkosCopy org={props.org} />
    </>
  );
}

/** The organization's searchable copy in WorkOS: CSV exports, and streams to a SIEM. */
function WorkosCopy(props: { org: AceOrgSpace }) {
  const portal = usePortalLink(props.org.id);
  const [error, setError] = useState("");
  const open = (intent: AceOrgPortalIntent) => {
    setError("");
    void openExternalWhenReady(portal.mutateAsync(intent).then((answer) => answer.link)).catch(
      (cause: unknown) => setError(orgFailure(cause)),
    );
  };
  return (
    <SettingSection
      label="Organization's copy"
      anchor="org.audit.workos"
      note="Kept for a year by default. Owners can keep it longer, never shorter."
    >
      <SettingRow
        title="Export as CSV"
        description="Up to 31 days per export, by action, member or target."
        inline
      >
        <Button
          size="sm"
          variant="ghost"
          disabled={portal.isPending}
          onClick={() => open("audit_logs")}
        >
          Export
        </Button>
      </SettingRow>
      {orgAllows(props.org.role, "sso:manage") && (
        <SettingRow
          title="Stream"
          description="Send every entry to your SIEM or storage as it happens."
          inline
        >
          <Button
            size="sm"
            variant="ghost"
            disabled={portal.isPending}
            onClick={() => open("log_streams")}
          >
            Set up
          </Button>
        </SettingRow>
      )}
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
    </SettingSection>
  );
}
