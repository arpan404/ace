import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { ProviderConfiguration, type ProviderConfigurations } from "@ace/protocol";

/** SDK-specific preferences win a collision with a retired CLI default. */
export function cursorConfiguration(rows: ProviderConfigurations): ProviderConfigurations {
  const next: ProviderConfigurations = [];
  for (const value of rows) {
    const row = ProviderConfiguration.parse(value);
    const migrated = row.provider === "cursor" && row.instance === "cursor-cli-default";
    const instance = row.provider === "cursor" ? cursorInstanceId(row.instance) : row.instance;
    if (
      migrated &&
      rows.some((other) => other.provider === "cursor" && other.instance === instance)
    )
      continue;
    const rest = { ...row };
    delete rest.binaryPath;
    next.push(row.provider === "cursor" ? { ...rest, ...(instance ? { instance } : {}) } : row);
  }
  return next;
}
