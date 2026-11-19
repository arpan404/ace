import { readFileSync } from "node:fs";
import { z } from "zod";
import { ApnsOrigin, ApnsTopic, appleOrigins } from "@ace/notify/apns-client";

const positive = z.number().int().positive().max(1_000_000_000);
export const LimitsSchema = z.object({
  /** Requests per client IP (IPv6 /64) per hour. */
  perIp: positive.default(600),
  /** Registrations per daemon key per hour. */
  registrationsPerDaemon: positive.default(60),
  /** Pushes per daemon key per hour. */
  pushesPerDaemon: positive.default(600),
  /** Pushes per handle (one phone, one daemon) per hour. */
  pushesPerHandle: positive.default(120),
  /** Entries each limiter keeps before evicting the oldest. */
  maxEntries: positive.default(20_000),
  /** Concurrent APNs requests. */
  maxConcurrent: positive.max(1000).default(64),
});
export type Limits = z.infer<typeof LimitsSchema>;
const SealKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Use 32 random bytes in base64url")
  .transform((value) => Buffer.from(value, "base64url"));
export const GatewayConfig = z.object({
  port: z.number().int().min(0).max(65535).default(8788),
  bind: z.string().min(1).default("0.0.0.0"),
  /** The origin daemons sign for (`aud`), such as https://push.acehq.dev. */
  publicOrigin: ApnsOrigin,
  trustProxy: z.boolean().default(false),
  apns: z.object({
    teamId: z.string().regex(/^[A-Za-z0-9]{10}$/),
    keyId: z.string().regex(/^[A-Za-z0-9]{10}$/),
    privateKey: z.string().min(1).max(4096),
    topic: ApnsTopic,
    origins: z.object({ production: ApnsOrigin, sandbox: ApnsOrigin }).default({ ...appleOrigins }),
  }),
  /** The current sealing key first; older ones still open handles during a rotation. */
  sealKeys: z.array(z.instanceof(Buffer)).min(1).max(4),
  handleLifetimeMs: positive.default(30 * 24 * 60 * 60_000),
  limits: LimitsSchema.default(LimitsSchema.parse({})),
});
export type GatewayConfig = z.infer<typeof GatewayConfig>;

const envNumber = z
  .string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .optional();
/** Secrets come only from the environment or a mounted key file. */
export function readGatewayConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): GatewayConfig {
  const input = z
    .object({
      ACE_PUSH_PORT: envNumber,
      ACE_PUSH_BIND: z.string().min(1).optional(),
      ACE_PUSH_PUBLIC_ORIGIN: z.string(),
      ACE_PUSH_TRUST_PROXY: z.enum(["0", "1"]).optional(),
      ACE_PUSH_APNS_TEAM_ID: z.string(),
      ACE_PUSH_APNS_KEY_ID: z.string(),
      ACE_PUSH_APNS_KEY: z.string().optional(),
      ACE_PUSH_APNS_KEY_FILE: z.string().optional(),
      ACE_PUSH_APNS_TOPIC: z.string(),
      /** Test and staging only: a fake APNs (HTTPS, or HTTP on 127.0.0.1). */
      ACE_PUSH_APNS_ORIGIN: z.string().optional(),
      ACE_PUSH_SEAL_KEY: SealKey,
      ACE_PUSH_SEAL_KEY_PREVIOUS: SealKey.optional(),
      ACE_PUSH_LIMIT_PER_IP: envNumber,
      ACE_PUSH_LIMIT_REGISTRATIONS: envNumber,
      ACE_PUSH_LIMIT_PUSHES: envNumber,
      ACE_PUSH_LIMIT_PER_HANDLE: envNumber,
    })
    .parse(env);
  const privateKey =
    input.ACE_PUSH_APNS_KEY ??
    (input.ACE_PUSH_APNS_KEY_FILE ? readFile(input.ACE_PUSH_APNS_KEY_FILE) : undefined);
  if (!privateKey) throw new Error("Set ACE_PUSH_APNS_KEY_FILE or ACE_PUSH_APNS_KEY");
  return GatewayConfig.parse({
    ...(input.ACE_PUSH_PORT !== undefined ? { port: input.ACE_PUSH_PORT } : {}),
    ...(input.ACE_PUSH_BIND ? { bind: input.ACE_PUSH_BIND } : {}),
    publicOrigin: input.ACE_PUSH_PUBLIC_ORIGIN,
    trustProxy: input.ACE_PUSH_TRUST_PROXY === "1",
    apns: {
      teamId: input.ACE_PUSH_APNS_TEAM_ID,
      keyId: input.ACE_PUSH_APNS_KEY_ID,
      privateKey,
      topic: input.ACE_PUSH_APNS_TOPIC,
      ...(input.ACE_PUSH_APNS_ORIGIN
        ? {
            origins: {
              production: input.ACE_PUSH_APNS_ORIGIN,
              sandbox: input.ACE_PUSH_APNS_ORIGIN,
            },
          }
        : {}),
    },
    sealKeys: [
      input.ACE_PUSH_SEAL_KEY,
      ...(input.ACE_PUSH_SEAL_KEY_PREVIOUS ? [input.ACE_PUSH_SEAL_KEY_PREVIOUS] : []),
    ],
    limits: LimitsSchema.parse({
      perIp: input.ACE_PUSH_LIMIT_PER_IP,
      registrationsPerDaemon: input.ACE_PUSH_LIMIT_REGISTRATIONS,
      pushesPerDaemon: input.ACE_PUSH_LIMIT_PUSHES,
      pushesPerHandle: input.ACE_PUSH_LIMIT_PER_HANDLE,
    }),
  });
}
