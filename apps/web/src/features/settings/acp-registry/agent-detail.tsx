import type { RegistryAgent, RegistryInstallation } from "@ace/protocol";
import { CaretLeftIcon, XIcon } from "@phosphor-icons/react";
import { latestInstallation, compareVersions } from "@ace/ui-core/acp-registry";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ProviderSetupRow } from "@/features/provider-setup/index.ts";
import { useProviderAccountModels } from "@/features/accounts/index.ts";

/** The registry uses the same one-click installer and sign-in row as Settings and Setup. */
export function AgentDetail(props: {
  agent: RegistryAgent;
  installations: readonly RegistryInstallation[];
  onBack?: (() => void) | undefined;
  onClose(): void;
}) {
  const { agent } = props;
  const installed = latestInstallation(agent.acpAgentId, props.installations);
  const { model } = useProviderAccountModels();
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        {props.onBack && (
          <IconButton
            icon={CaretLeftIcon}
            label="Back to the registry"
            size="sm"
            onClick={props.onBack}
          />
        )}
        <h2 className="min-w-0 flex-1 truncate text-base font-medium">{agent.name}</h2>
        <IconButton icon={XIcon} label="Close agent setup" size="sm" onClick={props.onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <ProviderSetupRow
          provider="acp"
          acpAgentId={agent.acpAgentId}
          instance={installed?.instanceId}
          name={agent.name}
          missing={!installed}
          view={model("acp", agent.acpAgentId).view}
          updateAvailable={!!installed && compareVersions(agent.version, installed.version) > 0}
        />
        <p className="text-sm text-muted-foreground">{agent.description}</p>
      </div>
    </>
  );
}
