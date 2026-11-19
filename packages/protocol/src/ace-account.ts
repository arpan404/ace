import { z } from "zod";

export const AceAccountOrigin = z
  .string()
  // The pattern carries the shape into the JSON schema; the refinement checks it is an origin.
  .regex(/^(?:https:\/\/[^\s/?#@]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?)$/)
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
  /** As WorkOS reports it; only its shape is checked. */
  email: z
    .string()
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+$/),
  name: z.string().max(256),
  /** WorkOS verified the email; the market mints publishing grants only then (ADR 0174 §2). */
  emailVerified: z.boolean().optional(),
  /**
   * The account has a profile picture, served to its own sessions by `GET
   * /v1/account/picture`. The picture's own address never leaves the backend.
   */
  picture: z.boolean().optional(),
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
/**
 * Where the person's browser goes once ace sign-in ends, carrying only `?status=` (never a
 * token, code or login id): the apps' own link, or the web app's landing page on an origin the
 * backend allows.
 */
export const ACE_APP_SIGN_IN_RETURN = "ace://account/signed-in";
/**
 * ace's own account backend, which also serves ace's hosted relay as `wss://` on the same host
 * (ADR 0110, 0111). Apps and daemons use it unless their settings name another.
 */
export const ACE_HOSTED_ACCOUNT_ORIGIN = "https://cloud.acehq.dev";
/**
 * Where ace's backend was served before. The same backend still answers there, with the same
 * sessions, machines and relay, so what an app or daemon stored under one of these is still good.
 */
export const ACE_FORMER_HOSTED_ACCOUNT_ORIGINS: readonly string[] = ["https://relay.acehq.dev"];

const currentHost = new URL(ACE_HOSTED_ACCOUNT_ORIGIN).host;
const formerHosts = new Set(
  ACE_FORMER_HOSTED_ACCOUNT_ORIGINS.map((origin) => new URL(origin).host),
);
function onCurrentHost(value: string): string {
  const parts = /^(https|wss):\/\/([^/?#]+)(.*)$/is.exec(value);
  if (!parts?.[1] || !parts[2] || !formerHosts.has(parts[2].toLowerCase())) return value;
  return `${parts[1].toLowerCase()}://${currentHost}${parts[3] ?? ""}`;
}

/**
 * An account origin read back from storage (a session file, a saved session's key): a former
 * address of ace's backend reads as the current one, so nobody looks signed out after a move.
 */
export const StoredAceAccountOrigin = AceAccountOrigin.transform(onCurrentHost).meta({
  "x-ace-json-input": AceAccountOrigin,
  "x-ace-constraint": "A former address of ace's backend is decoded as the current one.",
});
/**
 * An `https://` or `wss://` address that may be on a former host of ace's backend (a saved
 * machine's relay, a relay setting), read as the same address on the current host. Any other
 * address is returned unchanged.
 */
export const HostedAddress = z.string().transform(onCurrentHost).meta({
  "x-ace-json-input": z.string(),
  "x-ace-constraint": "A former address of ace's backend is decoded as the current one.",
});
export const ACE_WEB_SIGN_IN_PATH = "/account/signed-in";

/** `POST /v1/account/login`; the body is optional. */
export const AceLoginRequest = z.object({
  /**
   * Who will hold the session (ADR 0190): `person`, an app the person signed in on; `machine`, a
   * daemon (`ace login`), whose session never speaks for the person. Without it, a sign-in with a
   * `returnTo` is an app's and one without is a daemon's, as older apps and daemons send them.
   */
  holder: z.enum(["person", "machine"]).optional(),
  returnTo: z
    .string()
    .max(2048)
    .optional()
    .meta({
      examples: [ACE_APP_SIGN_IN_RETURN, `https://app.example.com${ACE_WEB_SIGN_IN_PATH}`],
      "x-ace-constraint":
        "Exactly ace://account/signed-in, or an allowed web origin followed by /account/signed-in.",
    }),
});
export type AceLoginRequest = z.infer<typeof AceLoginRequest>;
/** The `status` a sign-in's return address is opened with. */
export const AceSignInReturnStatus = z.enum(["signed-in", "cancelled", "failed", "expired"]);
export type AceSignInReturnStatus = z.infer<typeof AceSignInReturnStatus>;

export const AceLoginStatus = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("complete"), session: AceAccountGrant }),
]);

/** `POST /v1/grants` (ADR 0111), authenticated by the ace session token. */
export const AceGrantRequest = z.object({
  /** `spade-cloud` is a machine's (ADR 0140); `market-publish` a publisher's (ADR 0168). */
  purpose: z.enum(["spade-cloud", "market-publish"]).optional(),
  kind: z.enum(["machine", "device"]),
  /** The machine's host id, or the requesting device's device id. */
  subject: z.string().min(1).max(128),
  /**
   * With a device grant: the daemon it is for (ADR 0190). Named, the grant is bound to that host
   * id; a person's grant always is.
   */
  host: z
    .string()
    .regex(/^[A-Z2-7]{52}$/)
    .optional(),
  /**
   * With `market-publish` from the person's own session: the one market request the grant may
   * make, `METHOD /path` (ADR 0190). The market takes sensitive actions only from such a grant.
   */
  action: z.string().min(1).max(512).optional(),
  /**
   * With a device grant: this device's public key (an uncompressed P-256 point, base64url). A
   * person's grant is bound to it, and each use is proven with its private key (ADR 0190).
   */
  key: z
    .string()
    .regex(/^[A-Za-z0-9_-]{87}$/)
    .optional(),
});
export type AceGrantRequest = z.infer<typeof AceGrantRequest>;
export const AceGrantResponse = z.object({
  /** Signed grant, verified with `@ace/account-grant`. */
  token: z.string().min(1).max(2048),
  expiresAt: z.number().int().positive(),
  /**
   * With a device grant asked for by the person's own session, naming `host` and `key`: the
   * person's format 2 grant (ADR 0190). A client proves it on a socket to that daemon
   * (`account.standing`), never offers it to the relay. Absent otherwise and from older backends.
   */
  standing: z.string().min(1).max(2048).optional(),
});
export type AceGrantResponse = z.infer<typeof AceGrantResponse>;

/**
 * `POST /v1/machine-credentials` (ADR 0190), authenticated by an ace session: a credential of
 * this machine's own, bound to its host id, which the daemon keeps instead of the session. The
 * answer is an `AceAccountGrant` whose token is the machine credential.
 */
export const AceMachineCredentialRequest = z.object({
  hostId: z.string().regex(/^[A-Z2-7]{52}$/),
  /** The relay host key the host id names (X25519, base64url). */
  hostKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /**
   * The credential to issue, chosen by the daemon and kept on its disk before it asks, so an
   * answer lost on the way is recovered by using it (ADR 0190).
   */
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** `machineCredentialProof` over the host id and credential, with the host key. */
  proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** Redeem an enrollment ticket the app got for this host id, instead of a session bearer. */
  ticket: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  /**
   * The daemon was the session's only holder (`ace login`, or its own session file): the
   * session can no longer be used by its token, and signing the machine out ends it.
   */
  sole: z.boolean().optional(),
  /**
   * The session was kept on this machine's disk (a session file from before machine
   * credentials): it never speaks for the person again.
   */
  exposed: z.boolean().optional(),
});
export type AceMachineCredentialRequest = z.infer<typeof AceMachineCredentialRequest>;

/**
 * `POST /v1/machine-enrollments` (ADR 0190), authenticated by the person's session: a
 * single-use ticket that signs one machine in. The app hands its daemon this, never its session;
 * the daemon redeems it with proof of the host key, for a machine credential.
 */
export const AceMachineEnrollmentRequest = z.object({ hostId: z.string().regex(/^[A-Z2-7]{52}$/) });
export const AceMachineEnrollment = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().positive(),
});
export type AceMachineEnrollment = z.infer<typeof AceMachineEnrollment>;

/** A machine signed in to an account, as `GET /v1/machines` lists it. */
export const AceMachine = z.object({
  hostId: z.string().regex(/^[A-Z2-7]{52}$/),
  name: z.string().max(256),
  platform: z.string().max(64),
  lastSeenAt: z.number().int().nonnegative(),
});
export type AceMachine = z.infer<typeof AceMachine>;
export const AceMachineList = z.object({ machines: z.array(AceMachine).max(1000) });
