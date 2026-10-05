/*
 * The service families of the wire (settings, history, registry, files, terminals, projects,
 * ...): the full `ClientMessage` and `ServerMessage`, the reply schemas the client checks and
 * the long-thread read requests the client worker decodes a tab's arguments with. Loaded on
 * demand (`loadServiceWire`), so a client decodes its first frames with the core stream alone.
 */
export {
  ClientMessage,
  ItemsWindowRequest,
  ThreadCatchUpRequest,
  ThreadReadStateRequest,
  ThreadSearchRequest,
  TurnsPageRequest,
  CursorAuthEvent,
  CursorAuthRequest,
  QueueResult,
  RegistryRequest,
  RegistryResult,
  ServerMessage,
  SettingsResult,
} from "@ace/protocol";
export { HistoryListResponse, HistoryScanResponse } from "@ace/protocol/history";

export { decodeServiceResponse } from "./service-requests.ts";
