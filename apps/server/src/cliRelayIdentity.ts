import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { createRelayDeviceIdentity, type RelayStoredDeviceIdentity } from "@ace/shared/relay";

const CLI_RELAY_DEVICE_IDENTITY_FILE = "relay-viewer-device-identity.json";

function isRelayStoredDeviceIdentity(value: unknown): value is RelayStoredDeviceIdentity {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deviceId === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.secretKey === "string" &&
    typeof candidate.publicKey === "string"
  );
}

export async function loadCliRelayDeviceIdentity(
  stateDir: string,
): Promise<RelayStoredDeviceIdentity> {
  const identityPath = Path.join(stateDir, CLI_RELAY_DEVICE_IDENTITY_FILE);
  try {
    const raw = await FS.readFile(identityPath, "utf8");
    await FS.chmod(identityPath, 0o600).catch(() => undefined);
    const parsed = JSON.parse(raw) as unknown;
    if (isRelayStoredDeviceIdentity(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to rotation below.
  }

  const created = createRelayDeviceIdentity();
  await FS.mkdir(Path.dirname(identityPath), { recursive: true });
  await FS.writeFile(identityPath, `${JSON.stringify(created, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return created;
}
