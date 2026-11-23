import { knownPaths, type ClientCore } from "@ace/client";
import { machineIconGlyphs } from "@ace/ui-core";
import { markOf } from "@ace/ui-core/fleet-map";
import type { MachineIcon } from "@ace/protocol";
import type { PatchSink } from "./agents.ts";
import { host } from "./host.ts";
import { preview } from "./presentation.ts";

/*
 * The mark this runtime's machine chose (`host.identity` › `icon`), read on every ready
 * connection, as the icon name Swift draws it by. Swift shows it on inbox rows only when several
 * machines are paired, with the machine's name as its label. A machine that won't say keeps the
 * mark last sent. Beside it go the machine's own id and the paths it says it serves (ADR 0114),
 * which only this authenticated connection may tell: Swift lists a machine reached both paired
 * and through the account once, and saves a paired machine's paths in its directory entry. The
 * machine's own name goes too, so a rename from any device reaches every paired phone the next
 * time it connects.
 */

const kindGlyphs: Record<string, string> = {
  laptop: "laptop",
  desktop: "desktop-tower",
  server: "hard-drives",
  phone: "device-mobile",
};

/**
 * The glyph a machine draws by: the shared mark rule (`markOf`, as the fleet map uses), so a
 * "MacBook" is a laptop and a phone mark on a named computer is a computer. The finer marks
 * (monitor, cloud, cpu, terminal) keep their own glyph.
 */
export function identityGlyph(name: string, icon: MachineIcon | undefined): string {
  if (icon && ["monitor", "cloud", "cpu", "terminal"].includes(icon.kind))
    return machineIconGlyphs[icon.kind];
  return kindGlyphs[markOf({ kind: "machine", name, icon: icon?.kind })] ?? "laptop";
}

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
        const patch = {
          type: "machine.identity",
          glyph: identityGlyph(reply.identity.displayName, reply.identity.icon),
          hostId: reply.identity.hostId,
          ...(reply.identity.displayName.trim()
            ? { name: preview(reply.identity.displayName.trim(), 256) }
            : {}),
          ...(reply.paths ? { paths: knownPaths(reply.paths) } : {}),
        };
        const said = JSON.stringify(patch);
        if (stopped || said === last) return;
        last = said;
        pump.put("machine:identity", () => patch);
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
