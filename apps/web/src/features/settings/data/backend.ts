import type { CatalogModel, Device, DeviceScope, ProviderKind } from "@ace/protocol";

/**
 * Everything Settings reads from or writes to the daemon, behind one narrow seam.
 *
 * TODO(train-2): wire to protocol when merged. @ace/client does not yet expose these requests,
 * so the app runs this interface against the fake daemon's settings fixture. Wiring is a
 * one-file change (a `daemonBackend(client)` beside `fake-backend.ts`):
 * - values / set / reset: `settings.subscribe`, `settings.set` (global layer), `settings.get`
 *   (packages/protocol/src/settings.ts, on main).
 * - providers: provider discovery + `accounts.list` (accounts PR #25).
 * - models / refreshModels: `models.list`, `models.refresh` (packages/protocol/src/models.ts).
 * - machines / devices / pair / revoke: the daemon's access HTTP API on main
 *   (`GET /v1/devices`, `POST /v1/pairings`, `DELETE /v1/devices/:id`).
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
  availability: "available" | "near_limit" | "exhausted" | "logged_out";
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
