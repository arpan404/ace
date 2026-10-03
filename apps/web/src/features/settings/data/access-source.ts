// TODO(client-gaps): feat/client-protocol-gaps. Everything here waits for daemon support a web
// client can reach: AccessClient for machines, devices, pairing and revoking, and a request to
// add an ACP agent by command. A real daemon gets `unavailableAccess()`; fake mode loads
// access-fake.ts.
import type { Device, DeviceScope } from "@ace/protocol";
import { UnavailableError } from "@/boot/fake-backend.ts";
import type { Machine, Pairing } from "./backend.ts";

/** An ACP agent added by command that discovery hasn't reported yet. */
export interface AcpAgentInstall {
  name: string;
  binary: string;
}

export interface AccessSource {
  acpAgents(): Promise<AcpAgentInstall[]>;
  addAcpAgent(agent: { name: string; command: string }): Promise<void>;
  machines(): Promise<Machine[]>;
  devices(): Promise<Device[]>;
  pair(scopes: DeviceScope[]): Promise<Pairing>;
  revoke(deviceId: string): Promise<void>;
}

const no = (feature: string) => () => Promise.reject(new UnavailableError(feature));

export function unavailableAccess(): AccessSource {
  return {
    acpAgents: async () => [],
    addAcpAgent: no("Adding an ACP agent by command"),
    machines: no("Listing machines"),
    devices: no("Listing paired devices"),
    pair: no("Pairing from the web app"),
    revoke: no("Revoking devices from the web app"),
  };
}
