import { orgAllows, orgRole } from "@ace/client/ace-org";
import { useClient } from "@ace/client-react";
import type { AceOrgSpace } from "@ace/protocol/ace-org";
import { useState } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { withStanding } from "@/boot/person-standing.ts";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import {
  SettingList,
  SettingListItem,
  SettingNote,
  SettingRow,
  SettingSection,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { accountMachineLine, useSpace } from "@/features/ace-account/index.ts";
import {
  enrollThisMachine,
  EnrollRefused,
  orgFailure,
  useOrgHostList,
  useReleaseHost,
} from "@/features/ace-org/index.ts";
import { useNow } from "@/lib/time.ts";

/**
 * Settings › Organization › Hosts (ADR 0206 §2.1, §2.7): the organization's machines, when each
 * was last seen; giving the window's own machine to the organization, by its owner with
 * `hosts:manage`; and releasing a host, by an owner. Neither deletes anything on the machine.
 */
export function HostsPage(props: { org: AceOrgSpace }) {
  const { org } = props;
  const hosts = useOrgHostList(org.id);
  const release = useReleaseHost(org.id);
  const { refresh } = useSpace();
  const now = useNow();
  const own = useDaemonConnection().account?.hostId;
  const owner = orgRole(org.role) === "owner";
  const [confirming, setConfirming] = useState<Confirming>();
  const [error, setError] = useState("");
  const rows = hosts.data ?? [];
  const isHost = own !== undefined && rows.some((host) => host.hostId === own);
  return (
    <>
      <SettingSection label="Hosts" anchor="org.hosts">
        {hosts.isLoading && <SettingNote>Loading hosts…</SettingNote>}
        {hosts.error && <SettingNote role="alert">{orgFailure(hosts.error)}</SettingNote>}
        {hosts.isSuccess && rows.length === 0 && (
          <SettingNote>No hosts yet. A host is the machine your shared bots run on.</SettingNote>
        )}
        {rows.length > 0 && (
          <SettingList aria-label="Hosts">
            {rows.map((host) => (
              <SettingListItem key={host.hostId} className="gap-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-ui font-medium text-foreground">
                    {host.name || "Unnamed machine"}
                    {host.hostId === own ? " (this machine)" : ""}
                  </span>
                  <span className="truncate text-xs text-subtle-foreground">
                    {accountMachineLine(host, now)}
                  </span>
                </span>
                {owner && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={release.isPending}
                    onClick={() =>
                      setConfirming({
                        title: `Release ${host.name || "this host"}?`,
                        body: `It stops answering to ${org.name} and signs in again before it speaks for anyone. Its bots and history stay on it.`,
                        confirm: "Release",
                        run: () => {
                          setError("");
                          release.mutate(host.hostId, {
                            onError: (cause) => setError(orgFailure(cause)),
                            onSuccess: () => void refresh(),
                          });
                        },
                      })
                    }
                  >
                    Release
                  </Button>
                )}
              </SettingListItem>
            ))}
          </SettingList>
        )}
        {error && (
          <SettingNote role="alert" className="text-destructive">
            {error}
          </SettingNote>
        )}
      </SettingSection>
      {orgAllows(org.role, "hosts:manage") && hosts.isSuccess && !isHost && (
        <GiveThisMachine org={org} onDone={() => void refresh()} />
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </>
  );
}

/** "Give this machine to Acme": only its owner, from here, with the machine's own consent. */
function GiveThisMachine(props: { org: AceOrgSpace; onDone(): void }) {
  const { org } = props;
  const daemon = useClient();
  const { calls } = useSpace();
  const [confirming, setConfirming] = useState<Confirming>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const give = () => {
    if (!calls) return;
    setBusy(true);
    setError("");
    void enrollThisMachine({
      daemon,
      orgs: calls.orgs,
      token: calls.token,
      org: org.id,
      withStanding: (send, refused) => withStanding(daemon, send, refused),
    })
      .then(props.onDone)
      .catch((cause: unknown) =>
        setError(
          cause instanceof EnrollRefused
            ? cause.message
            : "Couldn't reach this machine. Try again.",
        ),
      )
      .finally(() => setBusy(false));
  };
  return (
    <SettingSection label="This machine" anchor="org.enroll">
      <SettingRow
        title={`Give this machine to ${org.name}`}
        description="It becomes a host for shared bots. Use a machine signed in to team accounts, never your personal ones: a shared bot sends as whoever is signed in here."
        inline
      >
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            setConfirming({
              title: `Give this machine to ${org.name}?`,
              body: `It answers to ${org.name} from now on, and every paired device's access to it ends. Nothing on it is deleted: your earlier threads and bots stay yours.`,
              confirm: "Give it",
              run: give,
            })
          }
        >
          {busy ? "Giving…" : "Give"}
        </Button>
      </SettingRow>
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </SettingSection>
  );
}
