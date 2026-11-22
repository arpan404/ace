import { z } from "zod";
import { decodeBase64url, encodeBase64url } from "./index.ts";

/*
 * A person's statement (ADR 0190, amendment 1): a short-lived, purpose-bound claim the person's
 * device key signs, naming the account, the device, what it is for, its target and audience, and
 * when it ends. Any verifier holding the account's registered device keys checks it the same way:
 * the local daemon today, Spade locally and in ace's cloud later. One text form, one line per
 * field in a fixed order, so a verifier in any language checks the very bytes that were signed.
 */

/** A device key's id: the SHA-256 of its raw public point, base64url. */
const KeyId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Plain = z.string().regex(/^[A-Za-z0-9_.:,@+/=-]{1,1024}$/);

/** The longest a statement may live: it is made for one exchange, never kept. */
export const STATEMENT_LIFETIME_MS = 60_000;

/** What a statement is for. Each verifier takes only the purposes it knows. */
export const StatementPurpose = z.enum([
  /** The person's standing for sockets the app tagged (`target`), at one daemon (`audience`). */
  "standing",
  /** Enrolling the device key for those sockets: needs a fresh sign-in, never another statement. */
  "enroll",
]);

export const PersonStatement = z
  .strictObject({
    account: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
    device: KeyId,
    purpose: StatementPurpose,
    /** The route or action it allows, e.g. `socket`, later `PUT /v1/agents/a_1/security/permissions`. */
    action: z.string().regex(/^[A-Za-z0-9_.:,@+/= -]{1,256}$/),
    /** What it applies to: tagged sockets, later a bot. */
    target: Plain,
    /** The one verifier it is for: a daemon's relay host id, later a Spade. */
    audience: Plain,
    /** The verifier's single-use challenge. */
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .refine((s) => s.exp > s.iat && s.exp - s.iat <= STATEMENT_LIFETIME_MS, {
    message: "A statement lives a minute at most",
  });
export type PersonStatement = z.infer<typeof PersonStatement>;

const prefix = "ace-person-statement/v1";
const order = [
  "account",
  "device",
  "purpose",
  "action",
  "target",
  "audience",
  "nonce",
  "iat",
  "exp",
] as const;

/** The exact text a device key signs for `statement`. */
export function statementText(statement: PersonStatement): string {
  const parsed = PersonStatement.parse(statement);
  return [prefix, ...order.map((field) => `${field}=${parsed[field]}`)].join("\n");
}

/**
 * The statement `text` is, or undefined for anything that isn't one in canonical form: a signer
 * signs nothing else, and a verifier reads nothing else.
 */
export function readStatement(text: string): PersonStatement | undefined {
  if (text.length > 4096) return undefined;
  const lines = text.split("\n");
  if (lines[0] !== prefix || lines.length !== order.length + 1) return undefined;
  const raw: Record<string, string | number> = {};
  for (const [index, field] of order.entries()) {
    const line = lines[index + 1] ?? "";
    if (!line.startsWith(`${field}=`)) return undefined;
    const value = line.slice(field.length + 1);
    raw[field] = field === "iat" || field === "exp" ? Number(value) : value;
  }
  const parsed = PersonStatement.safeParse(raw);
  if (!parsed.success) return undefined;
  return statementText(parsed.data) === text ? parsed.data : undefined;
}

/** A device key's id (`device`): the SHA-256 of its raw P-256 public point. */
export async function deviceKeyId(publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(decodeBase64url(publicKey)));
  return encodeBase64url(new Uint8Array(digest));
}

/**
 * The statement `text` signed by `publicKey` (`proof`: ECDSA P-256 SHA-256, IEEE P1363,
 * base64url), if it is one, the key is the device it names, and it is live at `now`. The caller
 * still checks the account, purpose, audience, target and nonce it expects.
 */
export async function verifyStatement(input: {
  text: string;
  proof: string;
  publicKey: string;
  now: number;
}): Promise<PersonStatement | undefined> {
  const statement = readStatement(input.text);
  if (!statement || statement.exp <= input.now || statement.iat > input.now + 5_000)
    return undefined;
  if ((await deviceKeyId(input.publicKey)) !== statement.device) return undefined;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(decodeBase64url(input.publicKey)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signed = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new Uint8Array(decodeBase64url(input.proof)),
      new TextEncoder().encode(input.text),
    );
    return signed ? statement : undefined;
  } catch {
    return undefined;
  }
}
