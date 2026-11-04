/*
 * The rules a person sets on every machine at once (the web's Fleet › Access, the phone's Fleet
 * rules): remote access, the networks machines are reached over, and what agents from other
 * machines may do. Each rule names its daemon setting; clients read and write it per machine.
 */

/** The networks remote access serves, together (ADR 0112), each turned on or off. */
export const remoteNetworks = [
  { key: "remote.lan", label: "Local network" },
  { key: "remote.tailscale", label: "Tailscale" },
  { key: "remote.relay", label: "Relay" },
] as const;
export type RemoteNetworkKey = (typeof remoteNetworks)[number]["key"];

export const remoteNetworkNotes: Record<RemoteNetworkKey, string> = {
  "remote.lan": "Devices on the same network. Browsers must trust its HTTPS certificate.",
  "remote.tailscale":
    "Your private Tailscale network, from anywhere. For browsers, turn on HTTPS certificates in Tailscale.",
  "remote.relay": "From anywhere, through ace's relay or one you host.",
};

/** Why a machine is reachable with nothing turned on but remote access. */
export const accountReachNote =
  "A machine signed in to your ace account is also reachable through ace's relay from your account's devices.";

export const agentAccessOptions = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "operate", label: "Read and act" },
] as const;

export const agentAccessNotes: Record<(typeof agentAccessOptions)[number]["value"], string> = {
  off: "Agents on other machines can't use this one, whatever each machine is allowed.",
  read: "Agents on other machines may only read here, whatever each machine is allowed.",
  operate:
    "Each linked machine gets what its page allows. Agents and the browser start at Read and act.",
};

/** One fleet-wide rule: an on/off switch or a choice, with what each choice means. */
export interface FleetRule {
  key: string;
  title: string;
  note?: string;
  control: "toggle" | "choice";
  options?: readonly { value: string; label: string; note?: string }[];
  /** Asked before turning it off (a switch) or changing it (a choice) while it cuts connections. */
  confirm?: { title: string; body: string; action: string };
}

const withNotes = <V extends string>(
  options: readonly { value: V; label: string }[],
  notes: Record<V, string>,
) => options.map((option) => ({ ...option, note: notes[option.value] }));

export const fleetRules: readonly FleetRule[] = [
  {
    key: "remote.enabled",
    title: "Remote access",
    note: "Paired devices and linked machines can connect. Needed to pair and to link.",
    control: "toggle",
    confirm: {
      title: "Turn off remote access everywhere?",
      body: "This phone reaches its machines through remote access. Turning it off disconnects them, and their other paired devices too, until it's turned on again on each machine.",
      action: "Turn off",
    },
  },
  ...remoteNetworks.map((network): FleetRule => ({
    key: network.key,
    title: network.label,
    note: remoteNetworkNotes[network.key],
    control: "toggle",
    confirm: {
      title: `Turn off ${network.label} on every machine?`,
      body: "Machines this phone reaches that way may disconnect until it can reach them on another network.",
      action: "Turn off",
    },
  })),
  {
    key: "remote.hostedPairingLink",
    title: "Pairing links open app.acehq.dev",
    note: "Off, links open the web app each computer serves, which always matches its version.",
    control: "toggle",
  },
  {
    key: "remote.agentAccess",
    title: "Agents from other machines",
    control: "choice",
    options: withNotes(agentAccessOptions, agentAccessNotes),
  },
  {
    key: "remote.agentTransfers",
    title: "Agents can move projects and threads to other machines",
    control: "toggle",
  },
  {
    key: "remote.transferIgnoredFiles",
    title: "Bring ignored files",
    note: "Local files Git ignores, such as .env and local config, go too. Dependency folders are rebuilt there instead.",
    control: "toggle",
  },
];
