import { z } from "zod";

/**
 * Opaque identifiers. Branded so a ThreadId can't be passed where an AgentId
 * is expected. All are ace-assigned; provider-native ids live in `native`.
 */
const id = <B extends string>() => z.string().min(1).brand<B>();

export const HostId = id<"HostId">();
export type HostId = z.infer<typeof HostId>;

export const WorkspaceId = id<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof WorkspaceId>;

export const ThreadId = id<"ThreadId">();
export type ThreadId = z.infer<typeof ThreadId>;

export const RunId = id<"RunId">();
export type RunId = z.infer<typeof RunId>;

export const AgentId = id<"AgentId">();
export type AgentId = z.infer<typeof AgentId>;

export const ItemId = id<"ItemId">();
export type ItemId = z.infer<typeof ItemId>;

export const InteractionId = id<"InteractionId">();
export type InteractionId = z.infer<typeof InteractionId>;

export const BackgroundTaskId = id<"BackgroundTaskId">();
export type BackgroundTaskId = z.infer<typeof BackgroundTaskId>;

export const EventId = id<"EventId">();
export type EventId = z.infer<typeof EventId>;

export const CommandId = id<"CommandId">();
export type CommandId = z.infer<typeof CommandId>;

export const DeviceId = id<"DeviceId">();
export type DeviceId = z.infer<typeof DeviceId>;

/** Milliseconds since the Unix epoch. */
export const Timestamp = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;

/** Provider identity, shared across execution, accounts and persisted sessions. */
export const NativeSessionId = z.string().min(1).max(512);
export type NativeSessionId = z.infer<typeof NativeSessionId>;
