import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { SettingsService } from "@ace/settings";
import { loadNotificationChannels, pushTarget } from "./notification-config.ts";
import { loadPushKey } from "./local-files.ts";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "ace-push-config-"));
  roots.push(path);
  return path;
};
const settings = (values: Record<string, unknown>) =>
  ({
    async get(key: string) {
      if (!(key in values)) throw new Error(`no setting ${key}`);
      return { key, value: values[key], provenance: "global" as const };
    },
  }) as unknown as Pick<SettingsService, "get">;

test.skipIf(process.platform === "win32")(
  "the push key is generated once and kept from its owner",
  () => {
    const dataDir = root();
    const first = loadPushKey(dataDir);
    // A P-256 signing key the gateway accepts as a VAPID identity.
    const key = createPrivateKey(first);
    expect(key.asymmetricKeyType).toBe("ec");
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(statSync(join(dataDir, "push-key.pem")).mode & 0o777).toBe(0o600);
    expect(loadPushKey(dataDir)).toBe(first);
  },
);

test("the push key file stays readable after a restrictive umask repair", () => {
  const dataDir = root();
  loadPushKey(dataDir);
  expect(() => loadPushKey(dataDir)).not.toThrow();
});

test("a corrupt push key file fails instead of changing the daemon's identity", () => {
  const dataDir = root();
  writeFileSync(join(dataDir, "push-key.pem"), "not a key", { mode: 0o600 });
  expect(() => loadPushKey(dataDir)).toThrow("Invalid push signing key");
});

test("the push target follows the per-machine switch and gateway origin", async () => {
  expect(await pushTarget(undefined)).toEqual({
    enabled: true,
    origin: "https://push.acehq.dev",
  });
  const off = settings({
    "notifications.remotePush": false,
    "notifications.pushGatewayUrl": "http://127.0.0.1:8788",
  });
  expect(await pushTarget(off)).toEqual({ enabled: false, origin: "http://127.0.0.1:8788" });
  // Junk keeps the defaults; a dead settings read does too.
  const junk = settings({ "notifications.remotePush": "yes", "notifications.pushGatewayUrl": 7 });
  expect(await pushTarget(junk)).toEqual({
    enabled: true,
    origin: "https://push.acehq.dev",
  });
  const failing = {
    async get() {
      throw new Error("settings unavailable");
    },
  };
  expect(await pushTarget(failing)).toEqual({
    enabled: true,
    origin: "https://push.acehq.dev",
  });
});

test("channels always include the push transport with the daemon's identity", async () => {
  const dataDir = root();
  const { channels, close } = await loadNotificationChannels({
    env: {},
    dataDir,
    settings: settings({
      "notifications.remotePush": true,
      "notifications.pushGatewayUrl": "http://127.0.0.1:1",
    }),
  });
  try {
    expect(channels.push).toBeDefined();
    expect(channels.apns).toBeUndefined();
    expect(channels.webpush).toBeUndefined();
  } finally {
    close();
  }
});
