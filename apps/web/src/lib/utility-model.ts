import { resolveUtilityModel, type UtilityModel } from "@ace/ui-core";
import { useMemo } from "react";
import { useDaemonSetting } from "./daemon-setting.ts";
import { useModelCatalog } from "./model-catalog.ts";
import { useProviderStatuses } from "./provider-statuses.ts";

/**
 * The model this daemon writes titles and commit/PR drafts with: the person's choice, or the
 * ready-provider default. `model` is undefined while loading and when no provider can generate.
 */
export function useUtilityModel(): { model: UtilityModel | undefined; loaded: boolean } {
  const [choice] = useDaemonSetting("generation.model");
  const statuses = useProviderStatuses().data;
  const models = useModelCatalog();
  return useMemo(
    () =>
      statuses && models
        ? {
            model: resolveUtilityModel({
              choice: choice ?? null,
              // Ready here is the pickers' own truth: installed, enabled, signed in, not limited.
              ready: statuses.filter((row) => row.state === "ready").map((row) => row.provider),
              models,
            }),
            loaded: true,
          }
        : { model: undefined, loaded: false },
    [choice, statuses, models],
  );
}
