import type { ClientApi } from "@ace/client";
import type { OutsideGrantEntry } from "@ace/protocol";
import {
  arrangeGrants,
  clientDomainWords,
  endedWords,
  expiryWords,
  projectsWords,
  scopeWords,
} from "@ace/ui-core/outside-clients";
import { formatAgo } from "@ace/ui-core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { HairlineRow, RowGroup } from "@/components/hairline-row.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { Machine } from "@/lib/machines.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import {
  outsideGrants,
  onSignInsSettled,
  outsideKeys,
  revokeGrant,
  updateGrant,
  type GrantChange,
} from "./data/outside.ts";
import { GrantDialog } from "./grant-dialog.tsx";

/** A refusal's code, as the client carries a daemon's (`forbidden`, `unavailable`). */
function refusal(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  const code = String(error.code);
  return code === "daemon" && error instanceof Error ? error.message : code;
}

/**
 * Whether this window can manage the machine's outside clients: a grants list read means yes; a
 * refusal (not an administrator, or a daemon without outside clients) hides the section.
 */
export function useOutsideGrants(client: ClientApi) {
  const query = useQuery({
    queryKey: outsideKeys.grants,
    queryFn: () => outsideGrants(client),
    retry: (count, error) => !["forbidden", "unavailable"].includes(refusal(error)) && count < 1,
  });
  const hidden = query.isError && ["forbidden", "unavailable"].includes(refusal(query.error));
  return { query, hidden };
}

/**
 * Settings › a machine › Connected apps: each live outside grant on a hairline row (its name,
 * domain or "unverified", what it may do, its projects, when it was last used and when it
 * ends), opening its threads and access; ended grants below under a quiet "Ended". Renders
 * inside the machine's scope, so every read and change goes to that machine. `connect` is the
 * "Connect an app" section, shown only where the list is.
 */
export function ConnectedApps(props: { machine: Machine; client: ClientApi; connect?: ReactNode }) {
  const { machine, client } = props;
  const now = useNow();
  const toast = useToast();
  const queries = useQueryClient();
  const name = useProjectName();
  const { query, hidden } = useOutsideGrants(client);
  const [open, setOpen] = useState<string>();
  const [confirming, setConfirming] = useState<Confirming>();
  const refresh = () => queries.invalidateQueries({ queryKey: outsideKeys.grants });
  // A sign-in approved anywhere (this window, another, the phone) is a new grant to list.
  useEffect(
    () =>
      onSignInsSettled(
        client,
        () => void queries.invalidateQueries({ queryKey: outsideKeys.grants }),
      ),
    [client, queries],
  );
  const failed = (title: string) => (error: Error) =>
    toast.error({ title, description: error.message || `${machine.name} didn't answer.` });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeGrant(client, id),
    onSettled: refresh,
    onError: failed("Couldn't revoke it"),
  });
  const update = useMutation({
    mutationFn: (input: { id: string; change: GrantChange }) =>
      updateGrant(client, input.id, input.change),
    onSettled: refresh,
    onError: failed("Couldn't change its access"),
  });
  if (hidden) return null;
  const { live, ended } = arrangeGrants(query.data ?? [], now);
  const opened = live.find((grant) => grant.id === open);
  const askRevoke = (grant: OutsideGrantEntry) =>
    setConfirming({
      title: `Revoke ${grant.name}?`,
      body: `It loses access to ${machine.name} at once and its work stops. Its threads stay.`,
      confirm: "Revoke",
      run: () => {
        setOpen(undefined);
        revoke.mutate(grant.id);
      },
    });
  return (
    <>
      <RowGroup
        label="Connected apps"
        {...(query.isSuccess ? { count: live.length } : {})}
        anchor="connected-apps"
      >
        {query.isError && (
          <p role="alert" className="py-2.5 text-xs text-muted-foreground">
            {query.error.message || `${machine.name} didn't answer.`}
          </p>
        )}
        {query.isSuccess && live.length === 0 && (
          <p className="py-2.5 text-xs text-muted-foreground">No apps connected.</p>
        )}
        {live.map((grant) => (
          <HairlineRow
            key={grant.id}
            data-row="grant"
            title={grant.name}
            tag={clientDomainWords(grant.domain)}
            label={`${grant.name}, ${clientDomainWords(grant.domain)}`}
            sub={[
              scopeWords(grant.scopes),
              projectsWords(grant.projects, name),
              expiryWords(grant.expiresAt, now),
            ].join(" · ")}
            meta={grant.lastUsedAt === null ? "Not used yet" : formatAgo(grant.lastUsedAt, now)}
            onOpen={() => setOpen(grant.id)}
          />
        ))}
      </RowGroup>
      {ended.length > 0 && (
        <RowGroup label="Ended" count={ended.length}>
          {ended.map((grant) => (
            <HairlineRow
              key={grant.id}
              title={<span className="text-muted-foreground">{grant.name}</span>}
              tag={clientDomainWords(grant.domain)}
              sub={`${endedWords(grant)} ${formatAgo(grant.revokedAt ?? grant.expiresAt ?? now, now)} · ${scopeWords(grant.scopes)}`}
            />
          ))}
        </RowGroup>
      )}
      {props.connect}
      {opened && (
        <GrantDialog
          grant={opened}
          client={client}
          machineId={machine.primary ? undefined : machine.id}
          onSave={(change) => update.mutateAsync({ id: opened.id, change }).then(() => {})}
          onRevoke={() => askRevoke(opened)}
          onClose={() => setOpen(undefined)}
        />
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </>
  );
}
