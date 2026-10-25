import type { ClientCore } from "@ace/client";
import { transferMachines, type TransferMachine } from "@ace/ui-core/transfers";
import { z } from "zod";

const quiet = { timeoutMs: 15_000 };
const SettingsReply = z.object({
  entries: z.array(z.object({ key: z.string(), value: z.unknown() })).catch([]),
});

/**
 * The machines this one has fleet links to (`fleet.request` links), and its "Bring ignored
 * files" default (`remote.transferIgnoredFiles`). Either is undefined when it couldn't be read.
 */
export async function readLinks(owner: Pick<ClientCore, "request">): Promise<{
  machines: TransferMachine[] | undefined;
  ignoredByDefault: boolean | undefined;
}> {
  const [links, setting] = await Promise.allSettled([
    owner.request({ type: "fleet.request", operation: { op: "links" } }, quiet),
    owner.request({ type: "settings.get", key: "remote.transferIgnoredFiles", scope: {} }, quiet),
  ]);
  const result = links.status === "fulfilled" ? links.value.result : undefined;
  const entry =
    setting.status === "fulfilled"
      ? SettingsReply.parse(setting.value).entries.find(
          (each) => each.key === "remote.transferIgnoredFiles",
        )
      : undefined;
  return {
    machines: result?.kind === "links" ? transferMachines(result.links) : undefined,
    ignoredByDefault: typeof entry?.value === "boolean" ? entry.value : undefined,
  };
}
