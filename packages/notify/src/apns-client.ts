import { connect, type ClientHttp2Session } from "node:http2";
import { z } from "zod";
import { p256SigningKey, signJwt } from "./webpush-crypto.ts";

export type ApnsEnvironment = "sandbox" | "production";
export const appleOrigins: Readonly<Record<ApnsEnvironment, string>> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
/** HTTPS anywhere, or plain HTTP/2 on 127.0.0.1 so tests can run a local fake APNs. */
export const ApnsOrigin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" ||
          (url.protocol === "http:" && url.hostname === "127.0.0.1")) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Use an HTTPS origin")
  .transform((value) => new URL(value).origin);
const ApnsClientConfig = z.object({
  teamId: z.string().regex(/^[A-Za-z0-9]{10}$/),
  keyId: z.string().regex(/^[A-Za-z0-9]{10}$/),
  privateKey: z.string().max(4096),
  origins: z
    .object({ production: ApnsOrigin, sandbox: ApnsOrigin })
    .default({ ...appleOrigins }),
  maxConcurrent: z.number().int().min(1).max(1000).default(16),
});
export const ApnsToken = z.string().regex(/^[a-fA-F0-9]{16,400}$/);
export const ApnsTopic = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9.-]+$/);
export interface ApnsRequest {
  environment: ApnsEnvironment;
  token: string;
  topic: string;
  pushType: "alert" | "background";
  priority: 5 | 10;
  /** Seconds since the epoch after which APNs stops trying. */
  expiration: number;
  /** At most 64 bytes; APNs replaces a shown alert with the same id. */
  collapseId?: string;
  payload: Uint8Array;
}
/** `status` 0 means no HTTP answer: the connection failed, timed out, was aborted or is busy. */
export interface ApnsResponse {
  status: number;
  /** APNs' reason word for a refusal, such as `BadDeviceToken`. */
  reason?: string;
}
export interface ApnsClient {
  send(request: ApnsRequest, signal: AbortSignal): Promise<ApnsResponse>;
  close(): void;
}
const ErrorBody = z.object({ reason: z.string().max(100) });
const maxPayload = 4096;

/**
 * A bounded HTTP/2 APNs client with token authentication. One session per environment, an ES256
 * provider token refreshed every 50 minutes, a 10-second deadline per request and a cap on
 * concurrent streams. `open` is injectable so tests can point it at a local HTTP/2 server.
 */
export function createApnsClient(
  input: z.input<typeof ApnsClientConfig>,
  now: () => number,
  open: (origin: string) => ClientHttp2Session = connect,
): ApnsClient {
  const config = ApnsClientConfig.parse(input);
  const key = p256SigningKey(config.privateKey);
  const sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
  let token: { value: string; at: number } | undefined;
  let active = 0;
  let closed = false;
  const session = (environment: ApnsEnvironment) => {
    const existing = sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const owned = open(config.origins[environment]);
    sessions.set(environment, owned);
    const forget = () => {
      if (sessions.get(environment) === owned) sessions.delete(environment);
    };
    owned.on("error", () => {
      forget();
      owned.destroy();
    });
    owned.on("goaway", () => {
      forget();
      owned.close();
    });
    owned.on("close", forget);
    owned.setTimeout(60 * 60_000, () => owned.close());
    return owned;
  };
  const providerToken = () => {
    const at = now();
    if (!token || at - token.at >= 50 * 60_000 || at < token.at)
      token = {
        at,
        value: signJwt(
          key,
          { alg: "ES256", kid: config.keyId },
          { iss: config.teamId, iat: Math.floor(at / 1000) },
        ),
      };
    return token.value;
  };
  return {
    async send(request, signal) {
      if (closed || signal.aborted || active >= config.maxConcurrent) return { status: 0 };
      if (
        !ApnsToken.safeParse(request.token).success ||
        !ApnsTopic.safeParse(request.topic).success ||
        request.payload.length > maxPayload ||
        (request.collapseId !== undefined && Buffer.byteLength(request.collapseId) > 64)
      )
        return { status: 400, reason: "BadRequest" };
      active++;
      try {
        const headers: Record<string, string> = {
          ":method": "POST",
          ":path": `/3/device/${request.token}`,
          authorization: `bearer ${providerToken()}`,
          "apns-topic": request.topic,
          "apns-push-type": request.pushType,
          "apns-priority": String(request.priority),
          "apns-expiration": String(Math.max(0, Math.floor(request.expiration))),
        };
        if (request.collapseId) headers["apns-collapse-id"] = request.collapseId;
        const stream = session(request.environment).request(headers);
        return await new Promise<ApnsResponse>((resolve) => {
          let status = 0;
          const chunks: Buffer[] = [];
          let bytes = 0;
          let finished = false;
          const finish = (response: ApnsResponse) => {
            if (finished) return;
            finished = true;
            signal.removeEventListener("abort", abort);
            resolve(response);
            stream.close();
          };
          const abort = () => finish({ status: 0 });
          signal.addEventListener("abort", abort, { once: true });
          stream.setTimeout(10_000, abort);
          stream.on("response", (received) => {
            const parsed = z.coerce
              .number()
              .int()
              .min(100)
              .max(599)
              .safeParse(received[":status"]);
            status = parsed.success ? parsed.data : 0;
          });
          stream.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 4096) finish({ status });
            else chunks.push(chunk);
          });
          stream.on("error", () => finish({ status: 0 }));
          stream.on("end", () => {
            const reason = readReason(Buffer.concat(chunks));
            finish(reason ? { status, reason } : { status });
          });
          stream.on("close", () => finish({ status: 0 }));
          stream.end(request.payload);
        });
      } catch {
        return { status: 0 };
      } finally {
        active--;
      }
    },
    close() {
      closed = true;
      for (const owned of sessions.values()) owned.destroy();
      sessions.clear();
    },
  };
}
function readReason(body: Buffer): string | undefined {
  if (!body.length) return undefined;
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(body.toString("utf8")));
    return parsed.success ? parsed.data.reason : undefined;
  } catch {
    return undefined;
  }
}
