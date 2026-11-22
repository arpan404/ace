import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownerOrgOf } from "../account-access/owner.ts";

/*
 * Whether this machine is an organization's host, for the services that start before the
 * machine's account is loaded (ace MCP, outside MCP, fleet links, transfers). Until the account
 * is bound it reads `ace-owner.json` itself, once, so an org host is never taken for a person's
 * machine while it starts.
 */

export type OrgSource = { ownerKnown(): boolean; ownerOrg(): string | undefined };

export type OrgProbe = {
  /** The organization that owns this machine, or undefined on a person's machine. */
  org(): string | undefined;
  bind(source: OrgSource): void;
};

export function orgProbe(dataDir: string): OrgProbe {
  let source: OrgSource | undefined;
  let read = false;
  let fromFile: string | undefined;
  return {
    org() {
      if (source?.ownerKnown()) return source.ownerOrg();
      if (!read) {
        read = true;
        try {
          fromFile = ownerOrgOf(JSON.parse(readFileSync(join(dataDir, "ace-owner.json"), "utf8")));
        } catch {
          fromFile = undefined;
        }
      }
      return fromFile;
    },
    bind(next) {
      source = next;
    },
  };
}
