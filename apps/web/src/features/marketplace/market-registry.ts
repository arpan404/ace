import { useClient } from "@ace/client-react";
import type { RegistryAdmin } from "@ace/protocol/marketplace";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { market, marketKey } from "./market-api.ts";
import { MarketFailure } from "./market-model.ts";
import { usePersonGrant } from "./market-publishing.ts";

/*
 * An organization's registry as its admins see it (ADR 0206 amendment 5): every version with
 * its scan result, read through this window's machine with the person's own grant acting in the
 * organization, and withdrawing a version, which waits for the registry's signer.
 */

const registryKey = (org: string) => [...marketKey, "registry", org] as const;

export function useOrgRegistry(org: string) {
  const personGrant = usePersonGrant();
  return useDaemonQuery<RegistryAdmin>({
    queryKey: registryKey(org),
    read: async (client, signal) => {
      const { answer } = await market(
        client,
        { op: "publish", request: { action: "registry", org } },
        "publish",
        signal,
        personGrant,
      );
      if (answer.kind !== "registry") throw new MarketFailure("failed");
      return answer.registry;
    },
  });
}

export interface RegistryWithdrawal {
  type: RegistryAdmin["entries"][number]["type"];
  name: string;
  version: string;
  reason: string;
}

export function useOrgRegistryWithdraw(org: string) {
  const client = useClient();
  const cache = useQueryClient();
  const personGrant = usePersonGrant();
  return useMutation({
    mutationFn: (withdrawal: RegistryWithdrawal) =>
      market(
        client,
        { op: "publish", request: { action: "registryWithdraw", org, ...withdrawal } },
        "publish",
        undefined,
        personGrant,
      ),
    onSettled: () => cache.invalidateQueries({ queryKey: registryKey(org) }),
  });
}
