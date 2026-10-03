/*
 * The service families of the wire (settings, history, registry, files, terminals, ...): the
 * full `ClientMessage` and `ServerMessage` and the reply schemas the client checks. Loaded on
 * demand by `WireCodec`, so a client decodes its first frames with the core stream alone.
 */
export {
  ClientMessage,
  CursorAuthEvent,
  CursorAuthRequest,
  QueueResult,
  RegistryRequest,
  RegistryResult,
  ServerMessage,
  SettingsResult,
} from "@ace/protocol";
export { HistoryListResponse, HistoryScanResponse } from "@ace/protocol/history";
