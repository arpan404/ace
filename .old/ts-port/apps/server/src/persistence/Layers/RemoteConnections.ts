import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteRemoteConnectionByIdInput,
  GetRemoteConnectionByIdInput,
  GetRemoteConnectionByWsUrlInput,
  RemoteConnection,
  RemoteConnectionRepository,
  type RemoteConnectionRepositoryShape,
} from "../Services/RemoteConnections.ts";

const makeRemoteConnectionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRemoteConnectionRow = SqlSchema.void({
    Request: RemoteConnection,
    execute: (connection) =>
      sql`
        INSERT INTO remote_connections (
          connection_id,
          name,
          ws_url,
          auth_token,
          created_at,
          updated_at,
          last_connected_at
        )
        VALUES (
          ${connection.id},
          ${connection.name},
          ${connection.wsUrl},
          ${connection.authToken},
          ${connection.createdAt},
          ${connection.updatedAt},
          ${connection.lastConnectedAt}
        )
        ON CONFLICT (ws_url)
        DO UPDATE SET
          name = excluded.name,
          auth_token = excluded.auth_token,
          updated_at = excluded.updated_at,
          last_connected_at = excluded.last_connected_at
      `,
  });

  const getRemoteConnectionByWsUrlRow = SqlSchema.findOneOption({
    Request: GetRemoteConnectionByWsUrlInput,
    Result: RemoteConnection,
    execute: ({ wsUrl }) =>
      sql`
        SELECT
          connection_id AS "id",
          name,
          ws_url AS "wsUrl",
          auth_token AS "authToken",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_connected_at AS "lastConnectedAt"
        FROM remote_connections
        WHERE ws_url = ${wsUrl}
      `,
  });

  const getRemoteConnectionByIdRow = SqlSchema.findOneOption({
    Request: GetRemoteConnectionByIdInput,
    Result: RemoteConnection,
    execute: ({ id }) =>
      sql`
        SELECT
          connection_id AS "id",
          name,
          ws_url AS "wsUrl",
          auth_token AS "authToken",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_connected_at AS "lastConnectedAt"
        FROM remote_connections
        WHERE connection_id = ${id}
      `,
  });

  const listRemoteConnectionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RemoteConnection,
    execute: () =>
      sql`
        SELECT
          connection_id AS "id",
          name,
          ws_url AS "wsUrl",
          auth_token AS "authToken",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_connected_at AS "lastConnectedAt"
        FROM remote_connections
        ORDER BY updated_at DESC, connection_id ASC
      `,
  });

  const deleteRemoteConnectionRow = SqlSchema.void({
    Request: DeleteRemoteConnectionByIdInput,
    execute: ({ id }) =>
      sql`
        DELETE FROM remote_connections
        WHERE connection_id = ${id}
      `,
  });

  const upsert: RemoteConnectionRepositoryShape["upsert"] = (connection) =>
    upsertRemoteConnectionRow(connection).pipe(
      Effect.mapError(toPersistenceSqlError("RemoteConnectionRepository.upsert:query")),
    );

  const getByWsUrl: RemoteConnectionRepositoryShape["getByWsUrl"] = (input) =>
    getRemoteConnectionByWsUrlRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("RemoteConnectionRepository.getByWsUrl:query")),
    );

  const getById: RemoteConnectionRepositoryShape["getById"] = (input) =>
    getRemoteConnectionByIdRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("RemoteConnectionRepository.getById:query")),
    );

  const listAll: RemoteConnectionRepositoryShape["listAll"] = () =>
    listRemoteConnectionRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("RemoteConnectionRepository.listAll:query")),
    );

  const deleteById: RemoteConnectionRepositoryShape["deleteById"] = (input) =>
    deleteRemoteConnectionRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("RemoteConnectionRepository.deleteById:query")),
    );

  return {
    upsert,
    getByWsUrl,
    getById,
    listAll,
    deleteById,
  } satisfies RemoteConnectionRepositoryShape;
});

export const RemoteConnectionRepositoryLive = Layer.effect(
  RemoteConnectionRepository,
  makeRemoteConnectionRepository,
);
