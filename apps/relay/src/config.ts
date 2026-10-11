import { z } from "zod";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const duration = positive.max(2147483647);
export const HostId = z.string().regex(/^[A-Z2-7]{52}$/);
export const Ticket = z.string().regex(/^[a-f0-9]{64}$/);
export const LimitsSchema = z
  .object({
    maxConnectionsPerIp: positive.default(256),
    maxConnections: positive.default(1024),
    messagesPerSecond: positive.default(1000),
    messageBurst: positive.default(2000),
    maxFrameSize: positive.max(65535).default(65535),
    idleTimeoutMs: duration.default(60000),
    highWaterBytes: positive.default(262144),
    maxBufferedBytes: positive.default(1048576),
    maxIpEntries: positive.default(4096),
    handshakeTimeoutMs: duration.default(10000),
    ticketTimeoutMs: duration.default(10000),
  })
  .refine((value) => value.highWaterBytes <= value.maxBufferedBytes, {
    message: "High water exceeds buffer cap",
  });
export type Limits = z.infer<typeof LimitsSchema>;
export const HostOptionsSchema = z
  .object({
    maxClientChannels: positive.max(1024).default(64),
    helloTimeoutMs: duration.default(10000),
    handshakeTimeoutMs: duration.default(10000),
    idleTimeoutMs: duration.default(25000),
    pingIntervalMs: duration.default(10000),
    retryInitialMs: duration.default(250),
    retryMaxMs: duration.default(5000),
  })
  .refine((v) => v.retryInitialMs <= v.retryMaxMs, { message: "Retry initial exceeds maximum" });
const envNumber = z
  .string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .optional();
export function readRelayConfig(env: Record<string, string | undefined>) {
  const input = z
    .object({
      ACE_RELAY_PORT: envNumber,
      ACE_RELAY_BIND: z.string().min(1).optional(),
      ACE_RELAY_MAX_CONNECTIONS_PER_IP: envNumber,
      ACE_RELAY_MAX_CONNECTIONS: envNumber,
      ACE_RELAY_MESSAGES_PER_SECOND: envNumber,
      ACE_RELAY_MESSAGE_BURST: envNumber,
      ACE_RELAY_MAX_FRAME_SIZE: envNumber,
      ACE_RELAY_IDLE_TIMEOUT_MS: envNumber,
      ACE_RELAY_HIGH_WATER_BYTES: envNumber,
      ACE_RELAY_MAX_BUFFERED_BYTES: envNumber,
      ACE_RELAY_MAX_IP_ENTRIES: envNumber,
      ACE_RELAY_HANDSHAKE_TIMEOUT_MS: envNumber,
      ACE_RELAY_TICKET_TIMEOUT_MS: envNumber,
      ACE_RELAY_ALLOWED_HOST_IDS: z.string().optional(),
    })
    .parse(env);
  const limits = LimitsSchema.parse({
    maxConnectionsPerIp: input.ACE_RELAY_MAX_CONNECTIONS_PER_IP,
    maxConnections: input.ACE_RELAY_MAX_CONNECTIONS,
    messagesPerSecond: input.ACE_RELAY_MESSAGES_PER_SECOND,
    messageBurst: input.ACE_RELAY_MESSAGE_BURST,
    maxFrameSize: input.ACE_RELAY_MAX_FRAME_SIZE,
    idleTimeoutMs: input.ACE_RELAY_IDLE_TIMEOUT_MS,
    highWaterBytes: input.ACE_RELAY_HIGH_WATER_BYTES,
    maxBufferedBytes: input.ACE_RELAY_MAX_BUFFERED_BYTES,
    maxIpEntries: input.ACE_RELAY_MAX_IP_ENTRIES,
    handshakeTimeoutMs: input.ACE_RELAY_HANDSHAKE_TIMEOUT_MS,
    ticketTimeoutMs: input.ACE_RELAY_TICKET_TIMEOUT_MS,
  });
  return {
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(input.ACE_RELAY_PORT ?? 8787),
    bind: input.ACE_RELAY_BIND ?? "0.0.0.0",
    limits,
    ...(input.ACE_RELAY_ALLOWED_HOST_IDS !== undefined
      ? {
          allowedHostIds: z
            .array(HostId)
            .parse(
              input.ACE_RELAY_ALLOWED_HOST_IDS === ""
                ? []
                : input.ACE_RELAY_ALLOWED_HOST_IDS.split(",").map((id) => id.trim()),
            ),
        }
      : {}),
  };
}
export const ControlMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("registered"), hostId: HostId }),
  z.object({ type: z.literal("client"), ticket: Ticket }),
]);
export const HostControlMessage = z.object({ type: z.literal("reject"), ticket: Ticket });
