import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownerOrgOf, sealOrgOf } from "../account-access/owner.ts";

/*
 * Whether this machine is an organization's host, for the services that start before the
 * machine's account is loaded (ace MCP, outside MCP, fleet links, transfers). Until the account
 * is bound it reads `ace-owner.json` itself, once, so an org host is never taken for a person's
 * machine while it starts.
 */

export type OrgSource = {
  ownerKnown(): boolean;
  accessOrg(): string | undefined;
  /** Hears every change of the machine's account and owner; returns the unsubscribe. */
  onChange?(listener: () => void): () => void;
};

export type OrgProbe = {
  /** The organization that owns this machine, or undefined on a person's machine. */
  org(): string | undefined;
  bind(source: OrgSource): void;
  /**
   * Hears the machine's owner change, at the change itself (ADR 0209 §4.2): enrollment ends
   * work in flight then, not at a later pass. Returns the unsubscribe.
   */
  onChange?(listener: () => void): () => void;
};

export function orgProbe(dataDir: string): OrgProbe {
  let source: OrgSource | undefined;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  let read = false;
  let fromFile: string | undefined;
  return {
    org() {
      if (source?.ownerKnown()) return source.accessOrg();
      if (!read) {
        read = true;
        try {
          fromFile = ownerOrgOf(JSON.parse(readFileSync(join(dataDir, "ace-owner.json"), "utf8")));
        } catch {
          fromFile = undefined;
        }
        // A released organization's home stays under its policy (ADR 0209 amendment 1).
        try {
          fromFile ??= sealOrgOf(
            JSON.parse(readFileSync(join(dataDir, "ace-org-seal.json"), "utf8")),
          );
        } catch {
          // No seal: a person's machine.
        }
      }
      return fromFile;
    },
    bind(next) {
      unsubscribe?.();
      source = next;
      unsubscribe = next.onChange?.(() => {
        for (const listener of [...listeners]) listener();
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
