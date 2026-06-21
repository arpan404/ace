import * as NodeFs from "node:fs/promises";
import { Effect, FileSystem, Path } from "effect";
import { createRelayDeviceIdentity, type RelayStoredDeviceIdentity } from "@ace/shared/relay";
import { ServerConfig } from "./config";

let cachedIdentity: RelayStoredDeviceIdentity | null = null;

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

export const getRelayDeviceIdentity = Effect.fn("getRelayDeviceIdentity")(function* () {
  if (cachedIdentity) {
    return cachedIdentity;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  const identityPath = path.join(stateDir, "relay-device-identity.json");

  const existing = yield* fileSystem.readFileString(identityPath).pipe(
    Effect.map((raw) => {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRelayStoredDeviceIdentity(parsed)) {
        throw new Error("Stored relay identity is invalid.");
      }
      return parsed;
    }),
    Effect.catch(() => Effect.succeed<RelayStoredDeviceIdentity | null>(null)),
  );

  if (existing) {
    yield* Effect.promise(() => NodeFs.chmod(identityPath, 0o600).catch(() => undefined));
    cachedIdentity = existing;
    return existing;
  }

  const created = createRelayDeviceIdentity();
  yield* fileSystem.makeDirectory(path.dirname(identityPath), { recursive: true });
  yield* Effect.promise(() =>
    NodeFs.writeFile(identityPath, `${JSON.stringify(created, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }),
  );
  cachedIdentity = created;
  return created;
});

export function __resetRelayDeviceIdentityForTests(): void {
  cachedIdentity = null;
}
