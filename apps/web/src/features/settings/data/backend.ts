import type { Device, DeviceScope, ProviderKind } from "@ace/protocol";
import type { ProviderState } from "@ace/ui-core";

/**
 * Everything Settings reads from or writes to the daemon, behind one narrow seam
 * (daemon-backend.ts): values over `settings.subscribe` / `settings.set`, providers from
 * discovery and `accounts.list`, paired devices, pairing and revoking from the daemon's access routes (access-source.ts). Machines and ACP agents added by
 * command wait for daemon support (access-gaps.ts).
 */
export interface SettingsBackend {
  /** The daemon's settings as a live store (a mirror of `settings.subscribe`). */
  readonly values: ValuesStore;
  set(key: string, value: unknown): Promise<void>;
  /** Clear every key on the global layer; defaults apply again. */
  reset(): Promise<void>;
  providers(): Promise<ProviderInstall[]>;
  /** Run discovery again, e.g. after installing a CLI. */
  rediscover(): Promise<ProviderInstall[]>;
  /** False on a daemon that can't add ACP agents by command yet (Add is then disabled). */
  readonly canAddAcpAgent: boolean;
  addAcpAgent(agent: { name: string; command: string }): Promise<void>;
  removeAcpAgent(name: string): Promise<void>;
  machines(): Promise<Machine[]>;
  devices(): Promise<Device[]>;
  pair(scopes: DeviceScope[]): Promise<Pairing>;
  revoke(deviceId: string): Promise<void>;
}

export type SettingsValuesMap = Readonly<Record<string, unknown>>;

export interface ValuesStore {
  subscribe(listener: () => void): () => void;
  get(): SettingsValuesMap;
}

export interface ProviderAccount {
  id: string;
  label: string;
  plan: string;
  auth: "logged_in" | "logged_out" | "unknown";
  availability: "available" | "near_limit" | "exhausted" | "logged_out" | "unknown";
}

/** A provider CLI as discovery found it, with the person's ace accounts on it. */
export interface ProviderInstall {
  kind: ProviderKind;
  /** The ACP registry agent behind an `acp` install, which picks its mark. */
  acpAgentId?: string | undefined;
  name: string;
  binary: string;
  state: ProviderState;
  /** The CLI version an account reported; undefined when none did. */
  version: string | undefined;
  via?: string;
  /** Added by command in Settings (not discovered), so it can be removed there. */
  added?: boolean;
  accounts: ProviderAccount[];
}

/** A machine running the ace daemon that this app can see. */
export interface Machine {
  id: string;
  name: string;
  platform: "macos" | "linux" | "windows";
  current: boolean;
  threads: number;
  daemonVersion: string;
  online: boolean;
  lastSeenAt: number;
}

export interface Pairing {
  /** What the phone scans: the daemon's pairing URL with the one-time code in the fragment. */
  url: string;
  /** The same code, for typing on a device without a camera. */
  code: string;
  expiresAt: number;
}
