import { WsRpcGroup } from "@ace/contracts";
import { resolveWebSocketAuthConnection } from "./wsAuth";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);

type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

export interface WsClientConnectionIdentity {
  readonly clientSessionId: string;
  readonly connectionId: string;
}

export interface CreateWsRpcProtocolLayerInput {
  readonly target: string;
  readonly baseUrl?: string;
  readonly identity?: WsClientConnectionIdentity;
}

export function createWsRpcProtocolLayer(input: CreateWsRpcProtocolLayerInput) {
  const connection = resolveWebSocketAuthConnection(input.target, {
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.identity
      ? {
          clientSessionId: input.identity.clientSessionId,
          connectionId: input.identity.connectionId,
        }
      : {}),
  });
  const socketOptions = connection.protocols ? { protocols: [...connection.protocols] } : undefined;
  const socketLayer = Socket.layerWebSocket(connection.url, socketOptions).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );

  return RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
}
