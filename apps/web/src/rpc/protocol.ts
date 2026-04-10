import {
  createWsRpcProtocolLayer as createSharedWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsClientConnectionIdentity,
  type WsRpcProtocolClient,
} from "@ace/shared/wsRpcProtocol";

import { resolveServerUrl } from "../lib/utils";

export { makeWsRpcProtocolClient };
export type { WsClientConnectionIdentity, WsRpcProtocolClient };

export function createWsRpcProtocolLayer(url?: string, identity?: WsClientConnectionIdentity) {
  const resolvedTarget = resolveServerUrl({
    url,
    protocol: window.location.protocol === "https:" ? "wss" : "ws",
    pathname: "/ws",
  });
  return createSharedWsRpcProtocolLayer({
    target: resolvedTarget,
    baseUrl: window.location.origin,
    ...(identity ? { identity } : {}),
  });
}
