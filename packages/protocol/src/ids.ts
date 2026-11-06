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

/**
 * One app install's own identity (ADR 0115): a UUIDv7 the app makes on first run and keeps for
 * good. The same value names the install on every machine and every path, and is its ace
 * account device id. Older installs' ids (a UUIDv4, an `ios-` prefixed one) are accepted as is.
 */
export const InstallId = z
  .string()
  .regex(/^[A-Za-z0-9-]{8,64}$/)
  .meta({ examples: ["01936d1e-3f8a-7c2b-9d4e-5f6a7b8c9d0e"] });
export type InstallId = z.infer<typeof InstallId>;

/** Milliseconds since the Unix epoch. */
export const Timestamp = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;

/** Provider identity, shared across execution, accounts and persisted sessions. */
export const NativeSessionId = z.string().min(1).max(512);
export type NativeSessionId = z.infer<typeof NativeSessionId>;

/** Monotonic event-log position, shared by wire events and compact worker metadata. */
export const EventSequence = z.number().int().nonnegative();
