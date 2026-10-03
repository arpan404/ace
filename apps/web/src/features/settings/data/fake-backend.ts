import { Device, type CatalogModel, type DeviceScope, type ProviderKind } from "@ace/protocol";
import { settingsFixture } from "@ace/fake-daemon";
import type { Machine, Pairing, ProviderInstall, SettingsBackend } from "./backend.ts";
import { memoryValues } from "./values-store.ts";

// TODO(train-2): wire to protocol when merged. See backend.ts for the request each method maps to.

const pairingLifetimeMs = 10 * 60_000;
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Settings against the fake daemon's fixture, held in memory. Clock and randomness injected. */
export function fakeSettingsBackend(options: { now(): number; random(): number }): SettingsBackend {
  const fixture = settingsFixture(options.now());
  const values = memoryValues({ ...fixture.values });
  let providers: ProviderInstall[] = fixture.providers;
  let devices: Device[] = fixture.devices;
  const machines: Machine[] = fixture.machines;
  const models: CatalogModel[] = fixture.models;
  const code = () =>
    Array.from({ length: 8 }, (_, index) => {
      const letter = codeAlphabet[Math.floor(options.random() * codeAlphabet.length)] ?? "A";
      return index === 4 ? `-${letter}` : letter;
    }).join("");

  return {
    values,
    async set(key, value) {
      values.set(key, value);
    },
    async reset() {
      values.replace({});
    },
    async providers() {
      return providers;
    },
    async rediscover() {
      return providers;
    },
    async addAcpAgent(agent) {
      providers = [
        ...providers,
        {
          kind: "acp",
          name: agent.name,
          binary: agent.command.split(/\s+/)[0] ?? agent.command,
          version: null,
          via: "via ACP",
          accounts: [],
        },
      ];
    },
    async models(provider: ProviderKind) {
      return models.filter((model) => model.provider === provider);
    },
    async refreshModels(provider: ProviderKind) {
      return models.filter((model) => model.provider === provider);
    },
    async machines() {
      return machines;
    },
    async devices() {
      return devices.filter((device) => device.revokedAt === null);
    },
    async pair(scopes: DeviceScope[]): Promise<Pairing> {
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
