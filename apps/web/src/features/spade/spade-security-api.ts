import {
  parseSpadeBotSecurity,
  parseSpadeCheckpoints,
  parseSpadeEgress,
  parseSpadeGrantAnswer,
  parseSpadeSecurityMachine,
  parseSpadeUndoPreview,
  type SpadeAutonomy,
  type SpadeCommandsMode,
  type SpadeNetworkPolicy,
} from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * Spade's security boundaries (ADR 0167, spade/docs/security.md): the machine's sandbox, and per
 * bot its network policies, grants, folders, checkpoints and egress log. Each answer parsed
 * with `@ace/ui-core/spade-chat`; one that doesn't parse throws, in words.
 */

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

/** Every security read; one machine's under `[...securityKey, machine key, …]`. */
export const securityKey = ["spade", "security"] as const;

const agentPath = (agent: string, rest: string) => `/v1/agents/${segment(agent)}/${rest}`;

export async function readSecurityMachine(target: SpadeTarget, signal?: AbortSignal) {
  const body = await spadeHttp(target, "GET", "/v1/security", { signal });
  return sure(parseSpadeSecurityMachine(body), "security settings");
}

export async function readBotSecurity(target: SpadeTarget, agent: string, signal?: AbortSignal) {
  const body = await spadeHttp(target, "GET", agentPath(agent, "security"), { signal });
  return sure(parseSpadeBotSecurity(body), "security settings");
}

/** Which of a bot's network policies: its commands' or its plugins'. */
export type SpadeNetworkFor = "commands" | "plugins";

export async function setBotNetwork(
  target: SpadeTarget,
  agent: string,
  which: SpadeNetworkFor,
  policy: SpadeNetworkPolicy,
) {
  const path = agentPath(
    agent,
    which === "commands" ? "security/network" : "security/plugin-network",
  );
  const body = await spadeHttp(target, "PUT", path, { body: policy });
  return sure(parseSpadeBotSecurity(body), "security settings");
}

/** Resets one of a bot's network policies to the machine's. */
export async function resetBotNetwork(target: SpadeTarget, agent: string, which: SpadeNetworkFor) {
  const path = agentPath(
    agent,
    which === "commands" ? "security/network" : "security/plugin-network",
  );
  const body = await spadeHttp(target, "DELETE", path);
  return sure(parseSpadeBotSecurity(body), "security settings");
}

/** A bot's commands setting; null goes back to the machine's (ADR 0171). */
export async function setBotCommands(
  target: SpadeTarget,
  agent: string,
  commands: SpadeCommandsMode | null,
) {
  const body = await spadeHttp(target, "PUT", agentPath(agent, "security/commands"), {
    body: { commands },
  });
  return sure(parseSpadeBotSecurity(body), "security settings");
}

/** The machine's commands setting, which every bot inherits unless it sets its own. */
export async function setMachineCommands(target: SpadeTarget, commands: SpadeCommandsMode) {
  const body = await spadeHttp(target, "PUT", "/v1/security/commands", { body: { commands } });
  return sure(parseSpadeSecurityMachine(body), "security settings");
}

/** How a bot decides (ADR 0163, amendment 2); null follows its parent's or the machine's. */
export async function setBotAutonomy(
  target: SpadeTarget,
  agent: string,
  autonomy: SpadeAutonomy | null,
) {
  const body = await spadeHttp(target, "PUT", agentPath(agent, "security/autonomy"), {
    body: { autonomy },
  });
  return sure(parseSpadeBotSecurity(body), "security settings");
}

/** How bots without their own setting decide. */
export async function setMachineAutonomy(target: SpadeTarget, autonomy: SpadeAutonomy) {
  const body = await spadeHttp(target, "PUT", "/v1/security/autonomy", { body: { autonomy } });
  return sure(parseSpadeSecurityMachine(body), "security settings");
}

/** The machine's network rule for commands or plugins, which bots inherit. */
export async function setMachineNetwork(
  target: SpadeTarget,
  which: SpadeNetworkFor,
  policy: SpadeNetworkPolicy,
) {
  const path = which === "commands" ? "/v1/security/network" : "/v1/security/plugin-network";
  const body = await spadeHttp(target, "PUT", path, { body: policy });
  return sure(parseSpadeSecurityMachine(body), "security settings");
}

/** A grant's scope as Spade takes it: `{kind, …}`. */
export type SpadeGrantRequest =
  | { kind: "folder"; path: string; write: boolean }
  | { kind: "tool"; tool: string; arguments: Record<string, string> }
  | { kind: "git_push"; repo: string; branch: string }
  | { kind: "pr_comment"; repo: string; own_only: boolean };

export async function addGrant(target: SpadeTarget, agent: string, scope: SpadeGrantRequest) {
  const body = await spadeHttp(target, "POST", agentPath(agent, "grants"), { body: scope });
  return sure(parseSpadeGrantAnswer(body), "grant");
}

export async function removeGrant(target: SpadeTarget, agent: string, grant: string) {
  await spadeHttp(target, "DELETE", agentPath(agent, `grants/${segment(grant)}`));
}

export async function readCheckpoints(target: SpadeTarget, agent: string, signal?: AbortSignal) {
  const body = await spadeHttp(target, "GET", agentPath(agent, "checkpoints"), { signal });
  return sure(parseSpadeCheckpoints(body), "checkpoints");
}

export async function restoreCheckpoint(target: SpadeTarget, agent: string, checkpoint: string) {
  const path = agentPath(agent, `checkpoints/${segment(checkpoint)}/restore`);
  await spadeHttp(target, "POST", path);
}

/** What undoing the step at `seq` (and everything after it) would put back, before it does. */
export async function readUndoPreview(
  target: SpadeTarget,
  agent: string,
  seq: number,
  signal?: AbortSignal,
) {
  const body = await spadeHttp(target, "GET", agentPath(agent, `checkpoints/undo?seq=${seq}`), {
    signal,
  });
  return sure(parseSpadeUndoPreview(JSON.parse(body)), "undo");
}

export async function readEgress(target: SpadeTarget, agent: string, signal?: AbortSignal) {
  const body = await spadeHttp(target, "GET", agentPath(agent, "security/egress"), { signal });
  return sure(parseSpadeEgress(body), "network activity");
}

export const securityMachineKey = (machine: string) =>
  [...securityKey, machine, "machine"] as const;

/** The machine's sandbox and default sites, read once Spade answers. */
export function useSecurityMachine(enabled = true) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  return useQuery({
    queryKey: securityMachineKey(machine),
    queryFn: ({ signal }) => readSecurityMachine(client, signal),
    enabled,
    retry: false,
  });
}

/** One bot's part of the security reads, by `what` (`bot`, `checkpoints`, `egress`). */
export const botSecurityKey = (machine: string, agent: string, what: string) =>
  [...securityKey, machine, agent, what] as const;

export function useBotSecurity(agent: string) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  return useQuery({
    queryKey: botSecurityKey(machine, agent, "bot"),
    queryFn: ({ signal }) => readBotSecurity(client, agent, signal),
    retry: false,
  });
}
