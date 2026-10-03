// TODO(client-gaps): feat/client-protocol-gaps. Machines and ACP agents added by command have no
// daemon support yet (access-gaps.ts). This stand-in serves dev:fake and tests from the fake
// daemon's fixture; it is loaded on demand so a real-daemon bundle never runs it.
import { settingsFixture } from "@ace/fake-daemon";
import type { AccessGaps, AcpAgentInstall } from "./access-gaps.ts";

/** Clock injected; state is held in memory for this client. */
export function fakeGaps(options: { now(): number }): AccessGaps {
  const fixture = settingsFixture(options.now());
  let agents: AcpAgentInstall[] = [];
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
  };
}
