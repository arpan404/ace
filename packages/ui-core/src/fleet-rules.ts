/*
 * The rules a person sets on every machine at once (the web's Fleet › Access, the phone's Fleet
 * rules): remote access, the network machines are reached over, and what agents from other
 * machines may do. Each rule names its daemon setting; clients read and write it per machine.
 */

export const transportOptions = [
  { value: "lan", label: "Local network" },
  { value: "tailscale", label: "Tailscale" },
  { value: "relay", label: "Relay" },
] as const;

export const transportNotes: Record<(typeof transportOptions)[number]["value"], string> = {
  lan: "Same network only. Browsers must trust its HTTPS certificate.",
  tailscale:
    "Your private Tailscale network, from anywhere. For browsers, turn on HTTPS certificates in Tailscale.",
  relay: "Through a relay you host. The local network stays on for pairing.",
};

export const agentAccessOptions = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "operate", label: "Read and act" },
] as const;

export const agentAccessNotes: Record<(typeof agentAccessOptions)[number]["value"], string> = {
  off: "Agents on other machines can't use this one.",
  read: "They can check status and read pages here, never start work.",
  operate: "They can start threads here, answer and use its browser.",
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
  {
    key: "remote.transport",
    title: "Reached over",
    control: "choice",
    options: withNotes(transportOptions, transportNotes),
    confirm: {
      title: "Change the network every machine is reached over?",
      body: "Machines may disconnect from this phone until it can reach them on the new network.",
      action: "Change",
    },
  },
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
