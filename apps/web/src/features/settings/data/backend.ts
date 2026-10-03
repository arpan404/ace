import type { CatalogModel, Device, DeviceScope, ProviderKind } from "@ace/protocol";

/**
 * Everything Settings reads from or writes to the daemon, behind one narrow seam
 * (daemon-backend.ts): values over `settings.subscribe` / `settings.set`, providers from
 * `accounts.list`, models from `models.list` / `models.refresh`, paired devices, pairing and
 * revoking from the daemon's access routes (access-source.ts). Machines and ACP agents added by
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
  addAcpAgent(agent: { name: string; command: string }): Promise<void>;
  models(provider: ProviderKind): Promise<CatalogModel[]>;
  refreshModels(provider: ProviderKind): Promise<CatalogModel[]>;
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
  auth: "logged_in" | "logged_out";
  availability: "available" | "near_limit" | "exhausted" | "logged_out" | "unknown";
}

/** A provider CLI as discovery found it. `version: null` means it is not installed. */
export interface ProviderInstall {
  kind: ProviderKind;
  name: string;
  binary: string;
  version: string | null;
  via?: string;
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
