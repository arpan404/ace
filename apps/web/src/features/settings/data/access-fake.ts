// TODO(client-gaps): feat/client-protocol-gaps. Machines, paired devices, pairing and revoking
// need the daemon's access endpoints (AccessClient), and adding an ACP agent by command has no
// client request on main. This stand-in serves dev:fake and tests from the fake daemon's fixture;
// it is loaded on demand so a real-daemon bundle never runs it.
import { Device, type DeviceScope } from "@ace/protocol";
import { settingsFixture } from "@ace/fake-daemon";
import type { AccessSource, AcpAgentInstall } from "./access-source.ts";

const pairingLifetimeMs = 10 * 60_000;
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Clock and randomness injected; state is held in memory for this client. */
export function fakeAccess(options: { now(): number; random(): number }): AccessSource {
  const fixture = settingsFixture(options.now());
  let devices: Device[] = fixture.devices;
  let agents: AcpAgentInstall[] = [];
  const code = () =>
    Array.from({ length: 8 }, (_, index) => {
      const letter = codeAlphabet[Math.floor(options.random() * codeAlphabet.length)] ?? "A";
      return index === 4 ? `-${letter}` : letter;
    }).join("");
  return {
    async acpAgents() {
      return agents;
    },
    async addAcpAgent(agent) {
      agents = [
        ...agents,
        { name: agent.name, binary: agent.command.split(/\s+/)[0] ?? agent.command },
      ];
    },
    async machines() {
      return fixture.machines;
    },
    async devices() {
      return devices.filter((device) => device.revokedAt === null);
    },
    async pair(scopes: DeviceScope[]) {
      const pairingCode = code();
      const fragment = new URLSearchParams({ fingerprint: "SHA256:5f1c9a7e", code: pairingCode });
      return {
        url: `https://studio-mac.tailnet.ts.net:7417/pair#${fragment.toString()}&scopes=${scopes.join(",")}`,
        code: pairingCode,
        expiresAt: options.now() + pairingLifetimeMs,
      };
    },
    async revoke(deviceId: string) {
      const at = options.now();
      if (!devices.some((device) => device.id === deviceId && device.revokedAt === null))
        throw new Error("That device is no longer paired.");
      devices = devices.map((device) =>
        device.id === deviceId ? Device.parse({ ...device, revokedAt: at }) : device,
      );
    },
  };
}
