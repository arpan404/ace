import {
  normalizeWsUrl,
  resolveHostDisplayName,
  splitWsUrlAuthToken,
} from "@ace/shared/hostConnections";
import { Data, Effect, Layer, Option } from "effect";

import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";
import { RemoteConnectionRepositoryLive } from "./persistence/Layers/RemoteConnections";
import {
  RemoteConnectionRepository,
  type RemoteConnection,
} from "./persistence/Services/RemoteConnections";

export type CliRemoteConnectionSummary = RemoteConnection;

export interface AddCliRemoteConnectionResult {
  readonly status: "created" | "updated";
  readonly connection: CliRemoteConnectionSummary;
}

export interface RemoveCliRemoteConnectionResult {
  readonly connection: CliRemoteConnectionSummary;
}

export class CliRemoteConnectionCommandError extends Data.TaggedError(
  "CliRemoteConnectionCommandError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const CliRemoteConnectionServicesLive = Layer.mergeAll(
  RemoteConnectionRepositoryLive.pipe(Layer.provide(SqlitePersistenceLayerLive)),
);

const listConnections = Effect.gen(function* () {
  const repository = yield* RemoteConnectionRepository;
  return yield* repository.listAll();
});

const normalizeRemoteConnectionInput = Effect.fn("normalizeRemoteConnectionInput")(
  function* (input: {
    readonly wsUrl: string;
    readonly authToken?: string;
    readonly name?: string;
  }) {
    const normalized = yield* Effect.try({
      try: () => normalizeWsUrl(input.wsUrl),
      catch: (cause) =>
        new CliRemoteConnectionCommandError({
          message: "Remote host URL is invalid.",
          cause,
        }),
    });
    const { wsUrl, authToken: embeddedAuthToken } = splitWsUrlAuthToken(normalized);
    const explicitAuthToken = input.authToken?.trim() ?? "";
    return {
      wsUrl,
      authToken: explicitAuthToken.length > 0 ? explicitAuthToken : embeddedAuthToken,
      name: resolveHostDisplayName(input.name, wsUrl),
    } as const;
  },
);

const findConnectionBySelector = Effect.fn("findConnectionBySelector")(function* (
  selector: string,
) {
  const trimmedSelector = selector.trim();
  if (trimmedSelector.length === 0) {
    return yield* new CliRemoteConnectionCommandError({
      message: "Remote selector cannot be empty.",
    });
  }

  const connections = yield* listCliRemoteConnections;
  const byId = connections.filter((connection) => connection.id === trimmedSelector);
  if (byId.length === 1) {
    return byId[0]!;
  }
  if (byId.length > 1) {
    return yield* new CliRemoteConnectionCommandError({
      message: `Multiple remote connections matched '${trimmedSelector}'.`,
    });
  }

  const maybeNormalizedSelectorWsUrl = yield* Effect.sync(() => {
    try {
      return Option.some(splitWsUrlAuthToken(normalizeWsUrl(trimmedSelector)).wsUrl);
    } catch {
      return Option.none<string>();
    }
  });
  if (Option.isSome(maybeNormalizedSelectorWsUrl)) {
    const byWsUrl = connections.filter(
      (connection) => connection.wsUrl === maybeNormalizedSelectorWsUrl.value,
    );
    if (byWsUrl.length === 1) {
      return byWsUrl[0]!;
    }
    if (byWsUrl.length > 1) {
      return yield* new CliRemoteConnectionCommandError({
        message: `Multiple remote connections matched '${trimmedSelector}'.`,
      });
    }
  }

  const byName = connections.filter((connection) => connection.name === trimmedSelector);
  if (byName.length === 1) {
    return byName[0]!;
  }
  if (byName.length > 1) {
    return yield* new CliRemoteConnectionCommandError({
      message: `Multiple remote connections matched '${trimmedSelector}'. Use id or ws url.`,
    });
  }

  return yield* new CliRemoteConnectionCommandError({
    message: `Remote connection '${trimmedSelector}' was not found.`,
  });
});

export const listCliRemoteConnections = listConnections;

export const addCliRemoteConnection = Effect.fn("addCliRemoteConnection")(function* (input: {
  readonly wsUrl: string;
  readonly authToken?: string;
  readonly name?: string;
}) {
  const repository = yield* RemoteConnectionRepository;
  const normalized = yield* normalizeRemoteConnectionInput(input);
  const existingByWsUrl = yield* repository.getByWsUrl({ wsUrl: normalized.wsUrl });
  const now = new Date().toISOString();

  const existing = Option.getOrUndefined(existingByWsUrl);
  const upserted: RemoteConnection = {
    id: existing?.id ?? crypto.randomUUID(),
    name: normalized.name,
    wsUrl: normalized.wsUrl,
    authToken: normalized.authToken.length > 0 ? normalized.authToken : (existing?.authToken ?? ""),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastConnectedAt: existing?.lastConnectedAt ?? null,
  };

  yield* repository.upsert(upserted);

  const persisted = yield* repository.getByWsUrl({ wsUrl: normalized.wsUrl });
  if (Option.isNone(persisted)) {
    return yield* new CliRemoteConnectionCommandError({
      message: `Failed to persist remote connection '${normalized.wsUrl}'.`,
    });
  }

  return {
    status: existing ? ("updated" as const) : ("created" as const),
    connection: persisted.value,
  } satisfies AddCliRemoteConnectionResult;
});

export const removeCliRemoteConnection = Effect.fn("removeCliRemoteConnection")(function* (input: {
  readonly selector: string;
}) {
  const repository = yield* RemoteConnectionRepository;
  const connection = yield* findConnectionBySelector(input.selector);

  yield* repository.deleteById({ id: connection.id });

  return {
    connection,
  } satisfies RemoveCliRemoteConnectionResult;
});
