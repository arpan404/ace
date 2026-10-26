import type { ClientCore } from "@ace/client";
import { machineGlyph } from "@ace/ui-core";
import type { PatchSink } from "./agents.ts";
import { host } from "./host.ts";

/*
 * The mark this runtime's machine chose (`host.identity` › `icon`), read on every ready
 * connection, as the icon name Swift draws it by. Swift shows it on inbox rows only when several
 * machines are paired, with the machine's name as its label. A machine that won't say keeps the
 * mark last sent.
 */

export type MachineIdentityOwner = Pick<ClientCore, "request" | "connectionState">;

export function followMachineIdentity(owner: MachineIdentityOwner, pump: PatchSink): () => void {
  const connection = owner.connectionState();
  let stopped = false;
  let last: string | undefined;
  const read = () => {
    if (connection.getSnapshot() !== "ready") return;
    owner
      .request({ type: "host.identity", requestId: host.uuid() }, { timeoutMs: 15_000 })
      .then((reply) => {
        const glyph = machineGlyph(reply.identity.icon);
        if (stopped || glyph === last) return;
        last = glyph;
        pump.put("machine:identity", () => ({ type: "machine.identity", glyph }));
      })
      .catch(() => {});
  };
  const stop = connection.subscribe(read);
  read();
  return () => {
    stopped = true;
    stop();
  };
}
