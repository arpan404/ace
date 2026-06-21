import { Config, Effect, FileSystem, Random, Schema } from "effect";
import * as Crypto from "node:crypto";
import { ServerConfig } from "../config";

class IdentifyUserError extends Schema.TaggedErrorClass<IdentifyUserError>()("IdentifyUserError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

const hash = (value: string) =>
  Effect.try({
    try: () => Crypto.createHash("sha256").update(value).digest("hex"),
    catch: (error) =>
      new IdentifyUserError({
        message: "Failed to hash identifier",
        cause: error,
      }),
  });

const IdentityEnvConfig = Config.all({
  aceUserId: Config.string("ACE_TELEMETRY_USER_ID").pipe(Config.option),
  providerIdentitiesJson: Config.string("ACE_TELEMETRY_PROVIDER_IDENTITIES_JSON").pipe(
    Config.option,
  ),
});

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig;

  const anonymousId = yield* fileSystem.readFileString(anonymousIdPath).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const randomId = yield* Random.nextUUIDv4;
        yield* fileSystem.writeFileString(anonymousIdPath, randomId);
        return randomId;
      }),
    ),
  );

  return anonymousId;
});

const parseProviderIdentities = (
  jsonValue: string,
): Effect.Effect<Record<string, string>, IdentifyUserError> =>
  Effect.try({
    try: () => {
      const parsed = JSON.parse(jsonValue);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const identities: Record<string, string> = {};
      for (const [provider, value] of Object.entries(parsed)) {
        const normalizedProvider = provider.trim().toLowerCase();
        if (!normalizedProvider) continue;
        if (typeof value !== "string") continue;
        const normalizedValue = value.trim();
        if (!normalizedValue) continue;
        identities[normalizedProvider] = normalizedValue;
      }
      return identities;
    },
    catch: (error) =>
      new IdentifyUserError({
        message: "Failed to parse ACE_TELEMETRY_PROVIDER_IDENTITIES_JSON",
        cause: error,
      }),
  });

export interface TelemetryIdentity {
  readonly distinctId: string;
  readonly traits: Readonly<Record<string, unknown>>;
}

/**
 * getTelemetryIdentity - Uses an explicit ace user id when provided, otherwise
 * falls back to installation-scoped anonymous id. Optional provider-linked
 * identities are emitted as namespaced hashed traits.
 */
export const getTelemetryIdentity = Effect.gen(function* () {
  const envConfig = yield* IdentityEnvConfig.asEffect();
  const anonymousId = yield* Effect.result(upsertAnonymousId);
  if (anonymousId._tag === "Failure") {
    return null;
  }

  const anonymousDistinctId = yield* hash(anonymousId.success);
  const aceUserIdValue =
    envConfig.aceUserId._tag === "Some" ? envConfig.aceUserId.value.trim() : "";
  const distinctId =
    aceUserIdValue.length > 0 ? yield* hash(`ace-user:${aceUserIdValue}`) : anonymousDistinctId;

  let providerIdentityTraits: Record<string, string> = {};
  const providerIdentitiesJson = envConfig.providerIdentitiesJson;
  if (providerIdentitiesJson._tag === "Some" && providerIdentitiesJson.value.trim().length > 0) {
    const parsed = yield* parseProviderIdentities(providerIdentitiesJson.value);
    const entries = yield* Effect.forEach(
      Object.entries(parsed),
      ([provider, providerId]) =>
        hash(`${provider}:${providerId}`).pipe(
          Effect.map(
            (hashedProviderId) =>
              [`providerIdentity.${provider}`, `${provider}:${hashedProviderId}`] as const,
          ),
        ),
      { concurrency: "unbounded" },
    );
    providerIdentityTraits = Object.fromEntries(entries);
  }

  return {
    distinctId,
    traits: {
      identityType: aceUserIdValue.length > 0 ? "ace-user" : "anonymous-installation",
      ...providerIdentityTraits,
    },
  } satisfies TelemetryIdentity;
}).pipe(
  Effect.tapError((error) =>
    Effect.logWarning("Failed to resolve telemetry identity", { cause: error }),
  ),
  Effect.orElseSucceed(() => null),
);
