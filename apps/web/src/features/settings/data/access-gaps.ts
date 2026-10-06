// TODO(client-gaps): feat/client-protocol-gaps. The daemon has no route that lists the machines
// running ace for this person, and no request that adds an ACP agent by its command (the
// registry only installs listed agents). Against a real daemon these read as unavailable; fake
// mode loads access-fake.ts.
import { UnavailableError } from "@/boot/fake-backend.ts";
import type { Machine } from "./backend.ts";

/** An ACP agent added by command that discovery hasn't reported yet. */
export interface AcpAgentInstall {
  name: string;
  binary: string;
}

/** What Settings' access pages need that the daemon can't serve yet. */
export interface AccessGaps {
  /** Whether this daemon can add an ACP agent by command at all; the UI offers Add only then. */
  readonly canAddAcpAgent: boolean;
  acpAgents(): Promise<AcpAgentInstall[]>;
  addAcpAgent(agent: { name: string; command: string }): Promise<void>;
  removeAcpAgent(name: string): Promise<void>;
  machines(): Promise<Machine[]>;
}

export function unavailableGaps(): AccessGaps {
  return {
    canAddAcpAgent: false,
    acpAgents: async () => [],
    addAcpAgent: () => Promise.reject(new UnavailableError("Adding an ACP agent by command")),
    removeAcpAgent: () => Promise.reject(new UnavailableError("Removing an ACP agent")),
    machines: () => Promise.reject(new UnavailableError("Listing machines")),
  };
}
