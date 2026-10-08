import type { ClientApi } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  ProviderConfigurations,
  type ProviderConfiguration,
  type ProviderKind,
} from "@ace/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "./daemon-setting.ts";
import { catalogKey } from "./model-catalog.ts";

const writes = new WeakMap<ClientApi, Promise<void>>();
/** Serialize this client's edits and reread first so fields edited elsewhere survive. */
export function editProviderConfiguration(
  client: ClientApi,
  change: (rows: ProviderConfigurations) => ProviderConfigurations,
): Promise<void> {
  const next = (writes.get(client) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const reply = await client.request({
        type: "settings.get",
        key: "providers.configuration",
        scope: {},
      });
      if (!reply.ok)
        throw new Error("Couldn't read provider preferences. Reconnect and try again.");
      const before = ProviderConfigurations.parse(reply.entries[0]?.value ?? []);
      const value = ProviderConfigurations.parse(change(before));
      const saved = await client.request({
        type: "settings.set",
        key: "providers.configuration",
        value,
        layer: { kind: "global" },
      });
      if (!saved.ok)
        throw new Error("Couldn't save provider preferences. Check the values and try again.");
    });
  writes.set(client, next);
  void next
    .finally(() => {
      if (writes.get(client) === next) writes.delete(client);
    })
    .catch(() => {});
  return next;
}

export function changeProvider(
  rows: ProviderConfigurations,
  provider: ProviderKind,
  change: (row: ProviderConfiguration) => ProviderConfiguration,
): ProviderConfigurations {
  const own = rows.findIndex((row) => row.provider === provider && row.instance === undefined);
  if (own === -1) return ProviderConfigurations.parse([...rows, change({ provider })]);
  return ProviderConfigurations.parse(
    rows.map((row, index) => (index === own ? change(row) : row)),
  );
}

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
