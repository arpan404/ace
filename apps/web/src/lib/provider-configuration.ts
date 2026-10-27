import { useClient, useConnectionState } from "@ace/client-react";
import type { ProviderConfiguration, ProviderKind } from "@ace/protocol";
import { changeProvider, editProviderConfiguration } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "./daemon-setting.ts";
import { catalogKey } from "./model-catalog.ts";

export function useProviderConfiguration(provider: ProviderKind) {
  const client = useClient();
  const [rows] = useDaemonSetting("providers.configuration");
  const online = useConnectionState() === "ready";
  const query = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const update = async (change: (row: ProviderConfiguration) => ProviderConfiguration) => {
    setPending(true);
    try {
      await editProviderConfiguration(client, (current) =>
        changeProvider(current, provider, change),
      );
      await query.invalidateQueries({ queryKey: catalogKey });
      return true;
    } catch {
      toast.error({
        title: "Couldn't save provider preferences",
        description: "Check the values and try again.",
      });
      return false;
    } finally {
      setPending(false);
    }
  };
  return {
    value: rows?.find((row) => row.provider === provider && row.instance === undefined),
    loaded: rows !== undefined,
    disabled: !online || rows === undefined || pending,
    update,
  };
}
