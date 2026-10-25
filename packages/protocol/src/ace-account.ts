import { z } from "zod";

export const AceAccountOrigin = z
  .string()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.origin === value &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  }, "Expected an HTTPS origin or a loopback HTTP origin")
  .meta({
    examples: ["https://backend.example.com"],
    "x-ace-constraint":
      "An exact HTTPS origin, or an HTTP origin on localhost, 127.0.0.1 or [::1], without credentials, a path, query or fragment.",
  });

/** An ace identity, independent of provider accounts and paired-machine authority. */
export const AceAccount = z.object({
  id: z.string().min(1).max(256),
  email: z.email().max(320),
  name: z.string().max(256),
});
export type AceAccount = z.infer<typeof AceAccount>;

export const AceAccountSession = z.object({
  account: AceAccount,
  expiresAt: z.number().int().positive(),
});
export const AceAccountGrant = AceAccountSession.extend({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type AceAccountGrant = z.infer<typeof AceAccountGrant>;

export const AceLogin = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  loginUrl: z.url(),
  expiresAt: z.number().int().positive(),
});
export type AceLogin = z.infer<typeof AceLogin>;
export const AceLoginStatus = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("complete"), session: AceAccountGrant }),
]);
