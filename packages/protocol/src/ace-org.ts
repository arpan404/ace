import { z } from "zod";

/**
 * Organizations on ace's account backend (ADR 0206). An organization is a WorkOS organization
 * and its id is WorkOS's. A person's personal space is their account; each active membership is
 * another space.
 */

export const AceOrgId = z.string().regex(/^org_[A-Za-z0-9]{1,64}$/);
export type AceOrgId = z.infer<typeof AceOrgId>;
/**
 * A WorkOS role slug, as WorkOS gives it: `owner`, `admin`, `member`, `billing`, or one ace
 * doesn't know (an organization's own `org…` role), which ace authorizes as `member`.
 */
export const AceOrgRole = z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/);
/** The roles an admin may give from ace; only owners give `owner`. */
export const AceOrgAssignableRole = z.enum(["member", "admin", "owner"]);
export type AceOrgAssignableRole = z.infer<typeof AceOrgAssignableRole>;
export const AceOrgPlan = z.enum(["pilot", "team"]);

/** `?space=` on `GET /v1/machines`: the person's own machines, or one organization's hosts. */
export const AceSpace = z.union([z.literal("personal"), AceOrgId]);
export type AceSpace = z.infer<typeof AceSpace>;

/** One organization in the space switcher (`GET /v1/orgs`). */
export const AceOrgSpace = z.object({
  id: AceOrgId,
  name: z.string().max(256),
  role: AceOrgRole,
  plan: AceOrgPlan,
  /** The role is set by the organization's identity provider: ace's pages don't offer a change. */
  directoryManaged: z.boolean(),
  /** The directory left the organization with no active owner; ace support names one. */
  noOwner: z.boolean().optional(),
});
export type AceOrgSpace = z.infer<typeof AceOrgSpace>;
export const AceOrgList = z.object({ orgs: z.array(AceOrgSpace).max(1000) });

/** `POST /v1/orgs`: a new organization, with the person as its owner. */
export const AceOrgCreateRequest = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .meta({ "x-ace-constraint": "Leading and trailing whitespace is removed." }),
});

export const AceOrgMemberStatus = z.enum(["pending", "active", "inactive", "removed"]);
/** A member as the organization's mirror lists them (`GET /v1/orgs/{org}/members`). */
export const AceOrgMember = z.object({
  account: z.string().min(1).max(256),
  email: z.string().max(320).optional(),
  name: z.string().max(256).optional(),
  role: AceOrgRole,
  status: AceOrgMemberStatus,
  directoryManaged: z.boolean(),
});
export type AceOrgMember = z.infer<typeof AceOrgMember>;
export const AceOrgMemberList = z.object({ members: z.array(AceOrgMember).max(10_000) });
/** `PATCH /v1/orgs/{org}/members/{account}`. */
export const AceOrgRoleChange = z.object({ role: AceOrgAssignableRole });

/** `POST /v1/orgs/{org}/invitations`. WorkOS sends the mail; the link opens ace's join page. */
export const AceOrgInvitationRequest = z.object({
  email: z
    .string()
    .trim()
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+$/)
    .meta({ "x-ace-constraint": "Leading and trailing whitespace is removed." }),
  role: AceOrgAssignableRole.default("member"),
});
export const AceOrgInvitationState = z.enum(["pending", "accepted", "expired", "revoked"]);
export const AceOrgInvitation = z.object({
  id: z.string().min(1).max(128),
  email: z.string().max(320),
  role: AceOrgRole.optional(),
  /** WorkOS's state; one it adds later is kept as given. */
  state: z.union([AceOrgInvitationState, z.string().max(64)]),
  expiresAt: z.string().max(64),
});
export type AceOrgInvitation = z.infer<typeof AceOrgInvitation>;
export const AceOrgInvitationList = z.object({
  invitations: z.array(AceOrgInvitation).max(1000),
});

/** `POST /v1/orgs/{org}/portal`: a five-minute WorkOS Admin Portal link for one setup task. */
export const AceOrgPortalIntent = z.enum([
  "sso",
  "dsync",
  "audit_logs",
  "log_streams",
  "domain_verification",
  "certificate_renewal",
]);
export type AceOrgPortalIntent = z.infer<typeof AceOrgPortalIntent>;
export const AceOrgPortalRequest = z.object({ intent: AceOrgPortalIntent });
export const AceOrgPortalLink = z.object({ link: z.url(), expiresAt: z.number().int().positive() });

const EffectRule = z.enum(["off", "admins", "approvers"]);
const RaiseRule = z.enum(["never", "admins", "approvers"]);
/**
 * An organization's policy (ADR 0206 §3): a ceiling over what an org host would allow anyway, so
 * it only ever narrows. Every part is optional; a missing part leaves the host's own rule.
 */
export const AceOrgPolicy = z.object({
  effects: z
    .object({
      network_without_hosts: EffectRule,
      publish: EffectRule,
      send_as_person: EffectRule,
      pay: EffectRule,
      change_access: EffectRule,
    })
    .partial()
    .optional(),
  full_access: RaiseRule.optional(),
  commands_outside_sandbox: RaiseRule.optional(),
  members_create_bots: z.boolean().optional(),
  packages: z
    .object({
      sources: z
        .object({ market: z.boolean(), registry: z.boolean(), git: z.boolean() })
        .partial()
        .optional(),
      mode: z.enum(["allowlist", "open"]).optional(),
      allow: z
        .array(
          z.object({
            source: z.enum(["market", "registry", "git"]),
            name: z.string().min(1).max(256),
            versions: z.array(z.string().max(64)).max(100).optional(),
          }),
        )
        .max(1000)
        .optional(),
      block: z
        .array(
          z.union([
            z.object({ hash: z.string().regex(/^sha256:[0-9a-f]{64}$/) }),
            z.object({ name: z.string().min(1).max(256) }),
          ]),
        )
        .max(1000)
        .optional(),
    })
    .optional(),
  models: z
    .object({
      endpoints: z.array(z.string().min(1).max(253)).max(100).optional(),
      local: z.boolean().optional(),
      /** Shared bots never use coding subscriptions in M4. */
      subscriptions: z.literal(false).optional(),
    })
    .optional(),
  audit: z.object({ content: z.enum(["digests", "targets"]) }).optional(),
});
export type AceOrgPolicy = z.infer<typeof AceOrgPolicy>;
/** `PUT /v1/orgs/{org}/policy`: the next version. */
export const AceOrgPolicySetRequest = z.object({ policy: AceOrgPolicy });
/**
 * One stored version (`GET /v1/orgs/{org}/policy`): `body` is the exact text the statement's
 * `body_sha256` was made over, and `statement` the backend's signature on it, verified with
 * `verifyOrgPolicy` from `@ace/account-grant`.
 */
export const AceOrgPolicyVersion = z.object({
  org: AceOrgId,
  version: z.number().int().nonnegative(),
  body: z.string().max(65_536),
  statement: z.string().max(2048).optional(),
  setBy: z.string().max(256).optional(),
  setAt: z.number().int().nonnegative().optional(),
});
export type AceOrgPolicyVersion = z.infer<typeof AceOrgPolicyVersion>;

/** `POST /v1/orgs/{org}/hosts`: the person gives a machine they own to the organization. */
/**
 * A machine's consent to become one organization's host (ADR 0206 §2.1,
 * `@ace/account-grant/machine-proof` `orgEnrollProof`): its daemon gives it only to a socket that
 * proved the machine owner's standing, for one organization, once, for five minutes. `account` is
 * that owner, whose session must be the one enrolling; `hostKey` is the relay host key the host id
 * names; `proof` is the MAC under the secret that key shares with the backend's exchange key.
 */
export const AceOrgEnrollConsent = z.object({
  hostId: z.string().regex(/^[A-Z2-7]{52}$/),
  hostKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  org: AceOrgId,
  account: z.string().min(1).max(256),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
  expiresAt: z.number().int().positive(),
  proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type AceOrgEnrollConsent = z.infer<typeof AceOrgEnrollConsent>;

export const AceOrgHostEnrollRequest = z.object({
  hostId: z.string().regex(/^[A-Z2-7]{52}$/),
  /** The machine's own consent, for this host and organization; spent by enrolling. */
  consent: AceOrgEnrollConsent,
  /** The host's Ed25519 audit key, base64url, that signs its log's checkpoints. */
  auditKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});
export type AceOrgHostEnrollRequest = z.infer<typeof AceOrgHostEnrollRequest>;

/**
 * `POST /v1/orgs/{org}/hosts/{hostId}/credential` (ADR 0206 §2.1): an org host asks for its
 * organization credential, or renews it, with its host key. The credential has no person's
 * session behind it: a member signing out or leaving never touches it. It is issued once per
 * enrollment, renewed only while the organization still holds the host under that enrollment,
 * and revoked when the host is released. The answer is an `AceAccountGrant` for the
 * organization's own principal.
 */
export const AceOrgHostCredentialRequest = z.object({
  /** The relay host key the host id names (X25519, base64url). */
  hostKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** The credential to issue or renew, chosen by the daemon and kept on its disk first. */
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** When the daemon made `proof`, on its clock; the backend takes it within five minutes. */
  at: z.number().int().positive(),
  /** `orgHostCredentialProof` over the host id, organization, credential and `at`. */
  proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type AceOrgHostCredentialRequest = z.infer<typeof AceOrgHostCredentialRequest>;

const AuditRef = z.object({
  type: z.string().regex(/^[a-z_]{1,32}$/),
  id: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
});
/**
 * `POST /v1/orgs/{org}/audit`: one entry of an org host's log, forwarded with its machine
 * credential to the organization's WorkOS Audit Logs. `hash` is the entry's chain hash and the
 * idempotency key, so a retry never writes it twice. Metadata holds digests and names, never
 * content: at most 49 keys (WorkOS's 50, less the entry's hash, which the backend
 * adds) of at most 40 characters, values of at most 500.
 */
export const AceOrgAuditEntry = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  action: z.string().regex(/^[a-z_]+(\.[a-z_]+){1,3}$/),
  occurredAt: z.number().int().nonnegative(),
  /** The schema version in WorkOS the entry was written for. */
  version: z.number().int().positive().optional(),
  actor: AuditRef,
  targets: z.array(AuditRef).min(1).max(10),
  metadata: z
    .record(
      z.string().regex(/^[A-Za-z0-9_]{1,40}$/),
      z.union([z.string().max(500), z.number(), z.boolean()]),
    )
    .refine((value) => Object.keys(value).length <= 49, "At most 49 metadata keys")
    .meta({ "x-ace-constraint": "At most 49 keys." })
    .optional(),
});
export type AceOrgAuditEntry = z.infer<typeof AceOrgAuditEntry>;

/**
 * The answer when WorkOS won't let this session into the organization (not a member, or its
 * sign-in policy needs SSO or MFA this session didn't use): the client starts a sign-in with
 * `org`, and WorkOS applies the organization's policy.
 */
export const AceOrgSignInRequired = z.object({
  error: z.literal("org_sign_in_required"),
  org: AceOrgId,
});
