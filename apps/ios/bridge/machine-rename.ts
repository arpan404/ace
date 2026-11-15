import type { ClientCore } from "@ace/client";
import { z } from "zod";

/*
 * Renaming a machine from the phone, as web's machine editor does: the name is saved on the
 * machine (`host.displayName`), so every device shows it. The answer is the name the machine
 * now reports, which the phone also keeps as its own label.
 */

export const MachineRenameRequest = z.object({
  type: z.literal("machine.rename"),
  name: z.string().max(256),
});
export type MachineRenameRequest = z.infer<typeof MachineRenameRequest>;

export type MachineRenameReply = { ok: true; name: string } | { ok: false; message: string };

type Owner = Pick<ClientCore, "request">;
const refused = "This phone can't rename the machine. Pair it again with full access to rename it.";

export async function renameMachine(
  owner: Owner,
  request: MachineRenameRequest,
  signal: AbortSignal,
): Promise<MachineRenameReply> {
  const name = request.name.trim();
  if (!name) return { ok: false, message: "Enter a name for the machine." };
  const options = { signal, timeoutMs: 15_000 };
  // An administrator setting: a phone paired with less is refused, as an error or `ok: false`.
  const saved = await owner
    .request(
      { type: "settings.set", key: "host.displayName", value: name, layer: { kind: "global" } },
      options,
    )
    .catch((error: unknown) => {
      if (signal.aborted) throw error;
      return { ok: false };
    });
  if (!saved.ok) return { ok: false, message: refused };
  const { identity } = await owner.request({ type: "host.identity" }, options);
  return { ok: true, name: identity.displayName || name };
}
