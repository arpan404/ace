import { IsoDateTime } from "@ace/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const RemoteConnection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  wsUrl: Schema.String,
  authToken: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastConnectedAt: Schema.NullOr(IsoDateTime),
});
export type RemoteConnection = typeof RemoteConnection.Type;

export const GetRemoteConnectionByWsUrlInput = Schema.Struct({
  wsUrl: Schema.String,
});
export type GetRemoteConnectionByWsUrlInput = typeof GetRemoteConnectionByWsUrlInput.Type;

export const GetRemoteConnectionByIdInput = Schema.Struct({
  id: Schema.String,
});
export type GetRemoteConnectionByIdInput = typeof GetRemoteConnectionByIdInput.Type;

export const DeleteRemoteConnectionByIdInput = GetRemoteConnectionByIdInput;
export type DeleteRemoteConnectionByIdInput = typeof DeleteRemoteConnectionByIdInput.Type;

export interface RemoteConnectionRepositoryShape {
  readonly upsert: (connection: RemoteConnection) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getByWsUrl: (
    input: GetRemoteConnectionByWsUrlInput,
  ) => Effect.Effect<Option.Option<RemoteConnection>, ProjectionRepositoryError>;

  readonly getById: (
    input: GetRemoteConnectionByIdInput,
  ) => Effect.Effect<Option.Option<RemoteConnection>, ProjectionRepositoryError>;

  readonly listAll: () => Effect.Effect<ReadonlyArray<RemoteConnection>, ProjectionRepositoryError>;

  readonly deleteById: (
    input: DeleteRemoteConnectionByIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class RemoteConnectionRepository extends ServiceMap.Service<
  RemoteConnectionRepository,
  RemoteConnectionRepositoryShape
>()("ace/persistence/Services/RemoteConnections/RemoteConnectionRepository") {}
