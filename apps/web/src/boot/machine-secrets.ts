import type { KeyValueStorage } from "@ace/ui-core";
import type { MachineSecretStore } from "@ace/client/machines";

const indexKey = "ace.machines.secrets";
const tokenKey = (key: string) => `ace.machines.token.${key}`;
export function machineSecrets(
  local: KeyValueStorage,
  session: KeyValueStorage,
): MachineSecretStore {
  const keys = () => {
    try {
      const value: unknown = JSON.parse(local.getItem(indexKey) ?? "[]");
      return Array.isArray(value)
        ? value.filter((key): key is string => typeof key === "string").slice(0, 100)
        : [];
    } catch {
      return [];
    }
  };
  return {
    get: async (key) => session.getItem(tokenKey(key)) ?? local.getItem(tokenKey(key)),
    async set(key, token, remember = false) {
      local.setItem(indexKey, JSON.stringify([...new Set([...keys(), key])]));
      local.removeItem?.(tokenKey(key));
      session.removeItem?.(tokenKey(key));
      (remember ? local : session).setItem(tokenKey(key), token);
    },
    async delete(key) {
      local.removeItem?.(tokenKey(key));
      session.removeItem?.(tokenKey(key));
      local.setItem(indexKey, JSON.stringify(keys().filter((old) => old !== key)));
    },
  };
}
/** Includes the pre-index directory used by older builds, without loading pool code. */
export function forgetMachineTokens(local?: KeyValueStorage, session?: KeyValueStorage) {
  const keys = new Set<string>();
  try {
    const value: unknown = JSON.parse(local?.getItem("ace.machines.secrets") ?? "[]");
    if (Array.isArray(value)) for (const key of value) if (typeof key === "string") keys.add(key);
    const directory: unknown = JSON.parse(local?.getItem("ace.machines") ?? "null");
    if (
      directory &&
      typeof directory === "object" &&
      "machines" in directory &&
      Array.isArray(directory.machines)
    )
      for (const entry of directory.machines)
        if (
          entry &&
          typeof entry === "object" &&
          "hostId" in entry &&
          "deviceId" in entry &&
          typeof entry.hostId === "string" &&
          typeof entry.deviceId === "string"
        )
          keys.add(JSON.stringify([entry.hostId, entry.deviceId]));
  } catch {
    /* The secret index still covers malformed metadata. */
  }
  for (const key of keys) {
    local?.removeItem?.(tokenKey(key));
    session?.removeItem?.(tokenKey(key));
  }
  local?.removeItem?.("ace.machines.secrets");
}
