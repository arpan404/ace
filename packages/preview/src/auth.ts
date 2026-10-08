import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const Claims = z.object({
  audience: z.string().max(253),
  device: z.string().min(1).max(256),
  expires: z.number().int(),
  nonce: z.string().max(128),
  kind: z.enum(["link", "session"]),
});
type Claims = z.infer<typeof Claims>;
/** A signed link must be redeemed within a minute of minting. */
export const previewLinkMs = 60_000;
/** A redeemed session lasts an hour; clients refresh it by redeeming a fresh link before then. */
export const previewSessionMs = 3_600_000;
export type DeviceAuthority = {
  authorize(token: string): Promise<string | null>;
  isPaired(deviceId: string): Promise<boolean>;
};
export type AuthOptions = {
  secret: Uint8Array;
  now: () => number;
  nonce: () => string;
  authority: DeviceAuthority;
  maxLinks: number;
};

/** Pure expiry/signature policy; entropy, clock and pairing are supplied by the owner. */
export function createPreviewAuth(options: AuthOptions) {
  const issued = new Map<string, number>();
  const sign = (claims: Claims) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = createHmac("sha256", options.secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  };
  const verify = (token: string, audience: string, kind: Claims["kind"]): Claims | undefined => {
    if (token.length > 2048) return;
    const parts = token.split(".");
    if (parts.length !== 2) return;
    const [payload = "", signature = ""] = parts;
    const expected = createHmac("sha256", options.secret).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return;
    try {
      const parsed = Claims.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString()));
      if (!parsed.success) return;
      const c = parsed.data;
      if (c.audience !== audience || c.kind !== kind || c.expires <= options.now()) return;
      return c;
    } catch {
      return;
    }
  };
  const mintFor = async (audience: string, device: string) => {
    if (device.length === 0 || device.length > 256 || !(await options.authority.isPaired(device)))
      throw new Error("Paired device required");
    const now = options.now();
    for (const [nonce, expires] of issued) {
      if (expires > now) break;
      issued.delete(nonce);
    }
    if (issued.size >= options.maxLinks) throw new Error("Too many outstanding preview links");
    const nonce = options.nonce();
    if (issued.has(nonce)) throw new Error("Duplicate preview nonce");
    issued.set(nonce, now + previewLinkMs);
    return sign({ audience, device, nonce, expires: now + previewLinkMs, kind: "link" });
  };
  return {
    /** A link for the holder of a device token the authority accepts. */
    async mint(audience: string, deviceToken: string) {
      if (deviceToken.length > 4096) throw new Error("Invalid device token");
      const device = await options.authority.authorize(deviceToken);
      if (!device) throw new Error("Paired device required");
      return mintFor(audience, device);
    },
    /** A link for a device identity the caller has already authenticated by other means. */
    mintFor,
    async redeem(token: string, audience: string) {
      const c = verify(token, audience, "link");
      if (!c || !issued.delete(c.nonce)) return;
      if (!(await options.authority.isPaired(c.device))) return;
      return sign({ ...c, kind: "session", expires: options.now() + previewSessionMs });
    },
    async authenticate(token: string, audience: string) {
      const c = verify(token, audience, "session");
      if (!c || !(await options.authority.isPaired(c.device))) return;
      return c.device;
    },
  };
}
