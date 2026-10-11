import { useClient } from "@ace/client-react";
import { SourceControlPreferences, type ForgeRepository } from "@ace/protocol";
import { parsePrReference } from "@ace/ui-core";

/** Read the current connection's allowlist at submission, including after machine reconnects. */
export function usePrReference() {
  const client = useClient();
  return async (value: string, repository: ForgeRepository | undefined) => {
    const response = await client.request({ type: "settings.get", key: "sourceControl.preferences", scope: {} });
    const entry = response.entries.find((item) => item.key === "sourceControl.preferences");
    if (!response.ok || !entry) throw new Error("Couldn't read this computer's source control settings. Reconnect and try again.");
    const preferences = SourceControlPreferences.parse(entry.value);
    return parsePrReference(value, repository, preferences.hosts.map((item) => item.host));
  };
}
