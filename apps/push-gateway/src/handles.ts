import { createCipheriv, createDecipheriv } from "node:crypto";
import { z } from "zod";
import { ApnsToken } from "@ace/notify/apns-client";

const aad = Buffer.from("ace-push-handle-v1");
const Sealed = z.object({
  t: ApnsToken,
  e: z.enum(["sandbox", "production"]),
  d: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  x: z.number().int().nonnegative(),
});
export interface Registration {
  token: string;
  environment: "sandbox" | "production";
  /** The daemon identity the handle was sealed for. */
  daemon: string;
  expiresAt: number;
}

/**
 * A handle is a registration sealed with AES-256-GCM under the gateway's key, so the gateway
 * stores nothing. `nonce` is supplied by the caller (randomness is injected).
 */
export function sealHandle(key: Buffer, registration: Registration, nonce: Buffer): string {
  if (nonce.length !== 12) throw new Error("Handle nonce must be 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.from(
    JSON.stringify({
      t: registration.token.toLowerCase(),
      e: registration.environment,
      d: registration.daemon,
      x: registration.expiresAt,
    }),
  );
  return Buffer.concat([nonce, cipher.update(body), cipher.final(), cipher.getAuthTag()]).toString(
    "base64url",
  );
}
/** The registration inside a handle, trying each key in turn; undefined when none opens it. */
export function openHandle(keys: readonly Buffer[], handle: string): Registration | undefined {
  if (!/^[A-Za-z0-9_-]{40,1024}$/.test(handle)) return undefined;
  const bytes = Buffer.from(handle, "base64url");
  if (bytes.length < 12 + 16 + 2) return undefined;
  const nonce = bytes.subarray(0, 12);
  const tag = bytes.subarray(bytes.length - 16);
  const body = bytes.subarray(12, bytes.length - 16);
  for (const key of keys) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]);
      const parsed = Sealed.safeParse(JSON.parse(plain.toString("utf8")));
      if (!parsed.success) return undefined;
      return {
        token: parsed.data.t,
        environment: parsed.data.e,
        daemon: parsed.data.d,
        expiresAt: parsed.data.x,
      };
    } catch {
      // Try the next key.
    }
  }
  return undefined;
}
