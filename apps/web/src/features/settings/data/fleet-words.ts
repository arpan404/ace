import type { MachineCapability, MachineGrantLevel, RemoteNetworks } from "@ace/protocol";
import type { MachineStatus } from "@/lib/machines.ts";
import { listNames } from "./list-names.ts";

/*
 * The sentences Settings › Fleet says, from what the machines report. Pure: the page passes in
 * what it read, so each sentence can be checked against the state it describes.
 */

export type Tone = "on" | "warn" | "off";

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** Whether anything reaches this computer from away from its network. */
function fromAnywhere(networks: RemoteNetworks): boolean {
  return (
    networks.account.state === "on" ||
    networks.tailscale.state === "on" ||
    networks.relay.state === "on"
  );
}

/**
 * The page's one sentence under "Fleet": how many machines and devices, then whether this
 * computer can be reached, and what's missing when it can't. Nothing about reach while it loads.
 */
export function fleetLede(input: {
  machines: number;
  devices: number;
  enabled: boolean;
  networks: RemoteNetworks | undefined;
}): string {
  const { machines, devices } = input;
  const counts =
    machines <= 1
      ? devices === 0
        ? "Just this computer so far."
        : `This computer and ${plural(devices, "device")}.`
      : devices === 0
        ? `${plural(machines, "machine")}.`
        : `${plural(machines, "machine")} and ${plural(devices, "device")}.`;
  if (!input.enabled) return `${counts} Remote access is off, so only this computer can open it.`;
  const networks = input.networks;
  if (!networks) return counts;
  if (fromAnywhere(networks))
    return `${counts} Your devices can reach this computer from anywhere.`;
  if (networks.lan.state === "on")
    return `${counts} Devices on the same network can reach it. Sign in or turn on Tailscale to reach it from anywhere.`;
  return `${counts} Nothing can reach this computer yet. Turn on a network below.`;
}

/** Under this computer's name in the machine list: the networks that reach it. */
export function reachedThrough(enabled: boolean, networks: RemoteNetworks | undefined): string {
  if (!enabled) return "Remote access is off";
  if (!networks) return "This window's machine";
  const ways = [
    networks.account.state === "on" ? "your ace account" : undefined,
    networks.tailscale.state === "on" ? "Tailscale" : undefined,
    networks.lan.state === "on" ? "the local network" : undefined,
    networks.relay.state === "on" && networks.relay.address !== networks.account.address
      ? "your relay"
      : undefined,
  ].filter((way) => way !== undefined);
  return ways.length ? `Reached through ${listNames(ways)}` : "Nothing else can reach it yet";
}

/** A machine's state for its row and page: a dot and the words beside it. */
export function machineState(
  status: MachineStatus,
  failed: boolean,
): { tone: Tone; words: string } {
  switch (status) {
    case "online":
      return { tone: "on", words: "Online" };
    case "connecting":
      return { tone: "off", words: "Connecting" };
    case "machine_code":
      return { tone: "warn", words: "Asks for its machine code" };
    case "auth_failed":
      return { tone: "warn", words: "Refused this window. Add it again with a fresh pairing link" };
    case "offline":
      return { tone: "off", words: failed ? "Offline · couldn't reach it" : "Offline" };
  }
}

/** Where a network row starts: which network, and whether it's on in settings. */
export type DirectNetwork = "lan" | "tailscale";

const offWords: Record<DirectNetwork, string> = {
  lan: "Off. Turn it on for devices on the same Wi-Fi.",
  tailscale: "Off. Turn it on to reach this computer over your tailnet, from anywhere.",
};

/** "https://host:port" as a person reads it: "host:port". */
export function addressWords(address: string): string {
  return address.replace(/^[a-z]+:\/\//, "").replace(/\/$/, "");
}

/**
 * One sentence for the local network or Tailscale: on at its address, the reason it isn't
 * serving, or how to turn it on. `live` is the machine's report, when it gave one.
 */
export function directLine(
  network: DirectNetwork,
  on: boolean,
  live: RemoteNetworks[DirectNetwork] | undefined,
): { tone: Tone; words: string } {
  if (!on) return { tone: "off", words: offWords[network] };
  if (live?.state === "on")
    return {
      tone: "on",
      words: live.address ? `On at ${addressWords(live.address)}.` : "On.",
    };
  if (live?.error) return { tone: "warn", words: live.error };
  if (live && live.state !== "off") return { tone: "warn", words: "Starting." };
  return { tone: "on", words: "On." };
}

/** The ace account row: who this computer is signed in as, and what that gives. */
export function accountLine(input: {
  email: string | undefined;
  live: RemoteNetworks["account"] | undefined;
}): { tone: Tone; words: string } {
  if (!input.email)
    return {
      tone: "off",
      words: "Not signed in. Sign in to open this computer from your devices, from anywhere.",
    };
  if (input.live?.error) return { tone: "warn", words: input.live.error };
  return {
    tone: "on",
    words: `Signed in as ${input.email}. Your devices open this computer from anywhere.`,
  };
}

const capabilityWords: Record<MachineCapability, string> = {
  agents: "agents",
  browser: "browser",
  devices: "simulators",
  screen: "computer use",
  commands: "commands",
};
const order: readonly MachineCapability[] = ["agents", "browser", "devices", "screen", "commands"];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * What other machines' agents may use, in one line: "Agents, browser and simulators. Not
 * computer use or commands." `levels` is undefined while they differ between machines.
 */
export function grantSummary(
  levels: Partial<Record<MachineCapability, MachineGrantLevel>> | undefined,
): string {
  if (!levels) return "Differs between machines.";
  const allowed = order.filter((capability) => (levels[capability] ?? "off") !== "off");
  const refused = order.filter((capability) => (levels[capability] ?? "off") === "off");
  if (allowed.length === 0) return "Nothing yet.";
  const named = allowed.map((capability) =>
    levels[capability] === "read"
      ? `${capabilityWords[capability]} (read only)`
      : capabilityWords[capability],
  );
  const first = `${capitalize(listNames(named))}.`;
  if (refused.length === 0) return first;
  const not = refused.map((capability) => capabilityWords[capability]);
  return `${first} Not ${not.length > 1 ? `${not.slice(0, -1).join(", ")} or ${not.at(-1)}` : not[0]}.`;
}

/** The transfers row: whether work moves, and what goes with it. */
export function transferLine(input: { on: boolean; ignored: boolean; differs: boolean }): string {
  if (input.differs) return "Differs between machines.";
  if (!input.on) return "Off. Agents keep work on the machine it started on.";
  return input.ignored
    ? "On. Uncommitted changes and ignored files like .env go with them."
    : "On. Uncommitted changes go with them; ignored files like .env stay.";
}
