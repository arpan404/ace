import { createInstance, instanceEnv, type AccountRegistry } from "@ace/accounts";
import type { ModelInstance } from "@ace/models";

/**
 * The environment a Cursor SDK catalog worker starts with: the selected account's own home,
 * built again from the account registry. Variables the row unsets stay unset.
 */
export function cursorCatalogEnvironment(
  input: {
    registry: AccountRegistry | undefined;
    launchEnv: NodeJS.ProcessEnv;
    isFenced(id: string): boolean;
  },
  instance: Pick<ModelInstance, "id" | "homeDir" | "env" | "unsetEnv">,
): NodeJS.ProcessEnv {
  if (!instance.homeDir) throw new Error("SDK model catalog needs an instance home");
  const selected =
    input.registry?.get(instance.id)?.instance ??
    createInstance({
      id: instance.id,
      provider: "cursor",
      label: instance.id,
      homeDir: instance.homeDir,
    });
  if (selected.homeDir !== instance.homeDir || selected.provider !== "cursor")
    throw new Error("SDK catalog instance does not match accounts");
  if (input.isFenced(selected.id))
    throw Object.assign(new Error("Sign in to Cursor"), { code: "not_configured" });
  return instanceEnv(
    selected,
    {
      ...input.launchEnv,
      ...instance.env,
      ...Object.fromEntries((instance.unsetEnv ?? []).map((key) => [key, undefined])),
    },
    "cursor-sdk",
  );
}
