import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DeviceCredential, type UserBrowserStatus } from "@ace/protocol";
import {
  UserChromeBackend,
  UserChromeHub,
  type NavigationClock,
  type VideoHost,
} from "@ace/browser";
import {
  extensionDir,
  extensionId,
  hostCredentialPath,
  installNativeHost,
  installSupported,
  installedNativeHosts,
  uninstallNativeHost,
  writeExtension,
} from "@ace/browser-extension";
import type { Devices } from "./devices.ts";

export interface UserBrowserOptions {
  dataDir: string;
  platform: NodeJS.Platform;
  home: string;
  /** `LOCALAPPDATA`: Windows only, where browsers keep user data and ace its host launchers. */
  env: { XDG_CONFIG_HOME?: string | undefined; LOCALAPPDATA?: string | undefined };
  /** The Node that runs the native host; the daemon passes its own executable. */
  node: string;
  devices: Devices;
  now: () => number;
  clock: NavigationClock;
  /** More NativeMessagingHosts directories (tests point a browser's user-data-dir here). */
  extraHostDirs?: readonly string[];
  /** ace's encoder-only Chrome, for remote viewers' video of the person's tabs (ADR 0088). */
  videoEncoder?: () => VideoHost | undefined;
}

/**
 * "Use my Chrome" in the daemon (ADR 0084): the connected browsers, the `user` backend over
 * them, and what Settings can do: install the host and extension, revoke, stop.
 */
export class UserBrowserService {
  readonly hub: UserChromeHub;
  readonly backend: UserChromeBackend;
  private options: UserBrowserOptions;
  constructor(options: UserBrowserOptions) {
    this.options = options;
    this.hub = new UserChromeHub({ now: options.now, clock: options.clock });
    this.backend = new UserChromeBackend(
      this.hub,
      options.platform,
      options.videoEncoder ? { videoEncoder: options.videoEncoder } : {},
    );
  }
  private hostOptions() {
    return {
      platform: this.options.platform,
      home: this.options.home,
      dataDir: this.options.dataDir,
      env: this.options.env,
      ...(this.options.extraHostDirs ? { extraDirs: this.options.extraHostDirs } : {}),
    };
  }
  async status(): Promise<UserBrowserStatus> {
    const supported = installSupported(this.options.platform);
    const installed = supported ? await installedNativeHosts(this.hostOptions()) : [];
    const path = extensionDir(this.options.dataDir);
    const built = await readFile(`${path}/manifest.json`).then(
      () => true,
      () => false,
    );
    return {
      supported,
      extensionId,
      ...(built ? { extensionPath: path } : {}),
      installed,
      connections: this.hub.connections(),
    };
  }
  /** Writes the extension, a fresh host credential when needed, and every browser's manifest. */
  async install(): Promise<UserBrowserStatus> {
    if (!installSupported(this.options.platform))
      throw new Error("Use my Chrome isn't available on this platform yet");
    await writeExtension(extensionDir(this.options.dataDir));
    await this.ensureCredential();
    await installNativeHost({ ...this.hostOptions(), node: this.options.node });
    return this.status();
  }
  /** Ends every browser link and removes what install wrote outside ace's data. */
  async revoke(): Promise<UserBrowserStatus> {
    await this.hub.stopAll();
    const at = this.options.now();
    for (const device of this.options.devices.list())
      if (device.revokedAt === null && device.scopes.includes("user-browser"))
        this.options.devices.revoke(device.id, at);
    this.hub.closeAll("Use my Chrome was revoked");
    await rm(hostCredentialPath(this.options.dataDir), { force: true });
    if (installSupported(this.options.platform)) await uninstallNativeHost(this.hostOptions());
    return this.status();
  }
  async stop(): Promise<UserBrowserStatus> {
    await this.hub.stopAll();
    return this.status();
  }
  close(): void {
    this.hub.closeAll("ace is shutting down");
  }
  /** Keeps a working credential; replaces a missing or revoked one. */
  private async ensureCredential(): Promise<void> {
    const path = hostCredentialPath(this.options.dataDir);
    let current: DeviceCredential | undefined;
    try {
      current = DeviceCredential.safeParse(JSON.parse(await readFile(path, "utf8"))).data;
    } catch {
      // First install, or a damaged file: mint a new credential below.
    }
    if (current) {
      const device = this.options.devices.get(current.device.id);
      if (device?.revokedAt === null && device.scopes.includes("user-browser")) return;
    }
    const credential = this.options.devices.create(
      "ace for Chrome",
      ["user-browser"],
      this.options.now(),
    );
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(`${path}.tmp`, JSON.stringify(credential), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
}
