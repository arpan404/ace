import type { RegistryAgent, RegistryPendingUpdate } from "@ace/protocol";
import { providerDisplayName } from "@ace/ui-core";
import { registryUpdateSentence } from "@ace/ui-core/acp-registry";
import { approveAgentUpdate, readRegistry, RegistryError } from "@ace/ui-core/acp-registry-data";
import { useClient } from "@ace/client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { isStandingRefusal, withStanding } from "@/boot/person-standing.ts";
import { ConfirmPerson } from "@/features/ace-account/index.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { ProvidersGroup } from "../providers-group.tsx";
import { registryKey } from "./use-registry.ts";

/**
 * Settings → Providers: agents whose files changed since the person approved them (ADR 0044
 * amendment, agents that update themselves). ace won't run one until the person approves its
 * update here; then its threads carry on as before. Nothing shows while nothing waits.
 */
export function AgentUpdates() {
  const list = useDaemonQuery({ queryKey: registryKey, read: readRegistry });
  const updates = list.data?.updates ?? [];
  if (!updates.length) return null;
  return (
    <ProvidersGroup label="Waiting for your approval">
      {updates.map((update) => (
        <UpdateRow key={update.installationId} update={update} agents={list.data?.agents ?? []} />
      ))}
    </ProvidersGroup>
  );
}

const needsPerson = (error: unknown) =>
  error instanceof RegistryError && isStandingRefusal(error.reason);

function UpdateRow(props: { update: RegistryPendingUpdate; agents: readonly RegistryAgent[] }) {
  const { update } = props;
  const client = useClient();
  const queryClient = useQueryClient();
  const toast = useToast();
  const name =
    props.agents.find((agent) => agent.acpAgentId === update.acpAgentId)?.name ??
    providerDisplayName("acp", update.acpAgentId);
  const approve = useMutation({
    mutationFn: async () => {
      const result = await withStanding(
        client,
        () =>
          approveAgentUpdate(client, update)
            .then(() => undefined)
            .catch((error: unknown) => error),
        needsPerson,
      );
      if (result !== undefined) throw result;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: registryKey }),
    onError: (error) => {
      if (!needsPerson(error))
        toast.error({ title: `Couldn't approve ${name}`, description: error.message });
    },
  });
  return (
    <SettingRow
      title={`${name} changed`}
      description={
        needsPerson(approve.error) ? (
          <ConfirmPerson onConfirmed={() => approve.mutate()} />
        ) : (
          registryUpdateSentence(update)
        )
      }
      inline
    >
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Approve ${name}'s update`}
        disabled={approve.isPending}
        onClick={() => approve.mutate()}
      >
        Approve update
      </Button>
    </SettingRow>
  );
}
