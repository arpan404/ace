# 0206: Organizations on WorkOS: members, org hosts, shared bots, policy, audit and private registries

Status: accepted. Date: 2026-11-20. Decided by: the founder (2026-11-20): implement the org system
on WorkOS. Every open question is resolved below with a recommendation; the three that need the
founder are listed at the end. Milestone M4 of the [product plan](../product/spade-plan.md).

Amends:

- [ADR 0002](0002-local-cli-providers.md), narrowly: ace's account backend now also keeps an
  organization's membership mirror, policy and a copy of its audit metadata. It still holds no
  provider credential, no endpoint key and no conversation.
- [ADR 0111](0111-account-machine-access.md): "an account opens every machine on it" holds for a
  person's machines. An **org host** opens by membership and role, never by one account.
- [ADR 0190](0190-a-machine-keeps-a-machine-credential.md): a machine's owner (§3a) may be an
  organization; a new standing, `member`, is proved the same way as `person`.
- [ADR 0163](0163-spade-auto-review-only.md) amendment 1 and
  [ADR 0171](0171-spade-decides-on-effects.md) decision 2: for a shared bot, "the person" is
  that bot's named approvers.
- [ADR 0200](0200-spade-is-an-agent-operating-system.md) §3.4: an organization ceiling sits
  above the package ceiling.
- [ADR 0168](0168-ace-marketplace.md) §4, §6 and [ADR 0174](0174-market-publishers-discovery-and-scanning.md)
  §2, §3: org publishers, org visibility, manifests signed with an organization's key.
- [ADR 0187](0187-spade-bots-move-between-machines.md) and [ADR 0132](0132-spade-teams.md): a
  shared bot moves only between its organization's hosts; a club of shared bots stays inside its
  organization.

Builds on [ADR 0100](0100-ace-account-backend.md) (WorkOS AuthKit sign-in),
[ADR 0110](0110-cloudflare-relay.md) (relay), [ADR 0167](0167-spade-security-boundaries.md)
(grants, sandbox), [ADR 0195](0195-spade-reaches-the-person.md) (notices),
[ADR 0201](0201-spade-agent-format-is-an-open-standard.md)–[0205](0205-spade-bots-think-with-models-the-person-controls.md).

## Context

ace accounts identify one person. Everything a person owns (machines, bots, threads, keys) is
theirs alone, and the person's standing on a machine comes only from a browser sign-in proved
with a key in the client's memory (ADR 0190). M4 needs a team to share work without weakening
that: one always-on box running a CI watcher for five engineers, its sends approved by named
people, every outward step on record, packages from the team's own catalog, and sign-in through
the team's identity provider.

The account backend (`apps/cloud/src/account/`) already speaks to WorkOS User Management over
REST: `workos.ts` builds the AuthKit authorization URL with PKCE and calls
`POST /user_management/authenticate` with the `authorization_code` and `refresh_token` grants.
D1 keeps hashed sessions, sealed refresh tokens, machines, machine credentials and enrollment
tickets (`migrations/0001`–`0004`). Grants are signed in `@ace/account-grant`. `packages/accounts`
is about provider CLI accounts and is untouched by this ADR.

### What WorkOS provides (read 2026-11-20)

| Product                                                                                                                                                                                                                                                                                                    | What ace uses                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Users and organizations](https://workos.com/docs/authkit/users-organizations), [membership API](https://workos.com/docs/reference/authkit/organization-membership)                                                                                                                                        | An organization membership links a user to an organization, with status `pending`, `active` or `inactive`. A user may belong to many organizations. Deactivating sets `inactive` **and revokes all active sessions**; reactivating keeps the earlier role. Pending memberships can't be deactivated, only deleted.                                                                                                                                            |
| [Sessions: switching organizations](https://workos.com/docs/authkit/sessions)                                                                                                                                                                                                                              | A refresh with `organization_id` returns an access token whose `org_id`, `role` and `permissions` claims match the membership, or an authentication error when the session can't enter that organization; then the app starts a sign-in with `organization_id`. The token also carries `sub`, `sid` and `auth_time`, no MFA claim.                                                                                                                            |
| [Get authorization URL](https://workos.com/docs/reference/authkit/authentication/get-authorization-url)                                                                                                                                                                                                    | Takes `organization_id`, `invitation_token`, `login_hint`, `max_age`.                                                                                                                                                                                                                                                                                                                                                                                         |
| [Roles and permissions](https://workos.com/docs/authkit/roles-and-permissions)                                                                                                                                                                                                                             | Environment roles with immutable slugs, a default `member` role, permissions as slugs carried in the token (keep them short: tokens sit in 4 KB cookies elsewhere). Single role per membership by default. Roles can come from directory groups (SCIM) or SSO groups. Custom roles per organization are prefixed `org`. Changes emit `organization_membership.updated`.                                                                                       |
| [FGA](https://workos.com/docs/fga)                                                                                                                                                                                                                                                                         | Resource-scoped roles over a hierarchy, checked by API (sub-50 ms p95). Subjects today: organization memberships and groups. **Not used in M4** (decision 2.6).                                                                                                                                                                                                                                                                                               |
| [Invitations](https://workos.com/docs/authkit/invitations), [API](https://workos.com/docs/reference/authkit/invitation)                                                                                                                                                                                    | `POST /user_management/invitations {email, organization_id, role_slug, expires_in_days, inviter_user_id}`; the invitee chooses to join (so phishing orgs can't add people silently). Accepting soon after sending verifies the email. Corporate-domain invitations accept any address on that domain; consumer domains need the exact address.                                                                                                                |
| [Domain verification](https://workos.com/docs/authkit/domain-verification)                                                                                                                                                                                                                                 | DNS TXT through the Admin Portal; exact domain match, no subdomains; consumer domains refused. Only one organization per environment may put a domain in its **domain policy**.                                                                                                                                                                                                                                                                               |
| [JIT provisioning](https://workos.com/docs/authkit/jit-provisioning)                                                                                                                                                                                                                                       | Users on a verified domain, and SSO users, are added as members at sign-in. On by default; can be turned off. Guests must be invited first.                                                                                                                                                                                                                                                                                                                   |
| [Organization policies](https://workos.com/docs/authkit/organization-policies), [SSO](https://workos.com/docs/authkit/sso)                                                                                                                                                                                 | SAML and OIDC. Setting up SSO turns off the organization's other sign-in methods. The domain policy applies to every user on that domain, whatever organization they pick; the organization policy (SSO or MFA required) applies when the member enters that organization.                                                                                                                                                                                    |
| [Directory Provisioning](https://workos.com/docs/authkit/directory-provisioning) on [Directory Sync](https://workos.com/docs/directory-sync)                                                                                                                                                               | SCIM, hosted-directory and SFTP directories create AuthKit users and memberships (`directory_managed: true`), roles from group mappings. Deprovisioning an active member **deactivates the membership, revokes all the user's sessions and resets the role**; a pending one is deleted. Enabled by WorkOS support for the whole WorkOS team, only for directories created afterwards; turning it off needs support.                                           |
| [Audit Logs](https://workos.com/docs/audit-logs) ([export](https://workos.com/docs/audit-logs/exporting-events), [streams](https://workos.com/docs/audit-logs/log-streams), [metadata](https://workos.com/docs/audit-logs/metadata-schema), [versions](https://workos.com/docs/audit-logs/editing-events)) | Events `{action, occurred_at, actor, targets, context, metadata}` per organization, against schemas configured per action (versioned, immutable). `idempotency-key` header. Retention per organization: 30 days by default, 1–11 months or 1–10 years, **increase only**. CSV export by actions, actors, targets, at most 31 days per export. Log Streams to SIEMs, object storage or HTTPS. Metadata: at most 50 keys, names ≤ 40 chars, values ≤ 500 chars. |
| [Admin Portal](https://workos.com/docs/admin-portal)                                                                                                                                                                                                                                                       | Links for intents `sso`, `dsync`, `audit_logs`, `log_streams`, `domain_verification`, `certificate_renewal`. An API link lasts 5 minutes; its session outlives it. Passing `external_user_id` lets "revoke portal links" end every link and session of that admin.                                                                                                                                                                                            |
| [Events API](https://workos.com/docs/events/data-syncing/events-api)                                                                                                                                                                                                                                       | Ordered, replayable, cursor (`after`) based; events up to 90 days old, 30 days per request. Recommended over webhooks for user and directory events.                                                                                                                                                                                                                                                                                                          |

## Decision

### 1. The model

#### 1.1 An organization is a WorkOS organization

- ace's org id **is** the WorkOS organization id (`org_…`). The backend creates it
  (`POST /organizations`), then the creator's membership with role `owner`.
- Any signed-in person with a verified email may create one during M4 (founder question 1). It
  starts on plan `pilot` (§7).
- The backend keeps a **mirror** in D1, filled from the Events API, used for listing and fast
  refusals. It is never the authority for a grant: every org grant is decided on a fresh WorkOS
  answer (1.4).

#### 1.2 Roles

Environment roles in WorkOS, single-role mode, set once in the WorkOS dashboard:

| Role               | Permissions (slugs, kept short for the token)                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `owner`            | everything below, plus `org:delete`, `org:owners`, `registry:key`, `audit:retention`, `host:shell`            |
| `admin`            | `members:manage`, `policy:set`, `hosts:manage`, `bots:manage`, `registry:publish`, `audit:read`, `sso:manage` |
| `member` (default) | `bots:use`, `bots:create` (if the policy allows members to create shared bots)                                |
| `billing` (later)  | `billing:manage`, `audit:read`; defined at M6, assigned to nobody now                                         |

- **ace reads the role from the token's `role` claim and authorizes from ace's own table of
  role → permissions**, compiled into the backend and the daemon. The token's `permissions` claim
  is logged, not trusted alone, so a WorkOS dashboard edit can't widen what a role does in ace.
- **Unknown roles** (an organization's custom `org…` role, or one added later) are kept as raw
  data and shown, and authorize as `member`. Lenient decode, strict authorization.
- **At least one owner, always.** The backend refuses a change that would leave none (removing,
  demoting or deprovisioning the last owner is refused by ace; if the directory does it, the
  organization is flagged "No owner" and only ace support can name one after checking).
- Roles may come from the organization's directory groups or SSO groups. A `directory_managed`
  membership's role is the identity provider's: ace's pages show "Set by your identity provider"
  and don't offer the change.

#### 1.3 Joining

- **Invitations.** An admin invites by email from Organization › Members. The backend calls
  WorkOS's invitation API with `organization_id`, `role_slug` (`member` or `admin`; only owners
  invite owners), `inviter_user_id`, `expires_in_days: 7`. WorkOS sends the mail. The accept link
  is ace's: `https://cloud.acehq.dev/v1/orgs/join?invitation_token=…` shows the organization's
  name and the inviter and one button, "Join <org>"; only that button starts an ace sign-in
  whose authorization URL carries `invitation_token` (the ADR 0100 sign-in, with `holder:
person`). Opening the link spends nothing.
- **Domain capture.** An admin verifies the team's email domain through the Admin Portal
  (`domain_verification`). With the domain in the organization's domain policy, WorkOS JIT-adds
  anyone on it who signs in, as `member`. Recommended on for teams that want it, off by default
  in ace's guide; each JIT join is a `org.member.joined` audit entry and a notice to admins.
- **SSO.** An admin opens the Admin Portal (`sso`) from Organization › Sign-in. ace adds nothing
  of its own: WorkOS routes users of a captured domain to the identity provider and refuses a
  session that didn't use it when ace refreshes into the organization (1.4).
- **SCIM.** Directory Provisioning, through the Admin Portal (`dsync`). Requires WorkOS support
  to turn it on for ace's whole WorkOS team before the first customer directory exists
  (founder question 3).

#### 1.4 One sign-in, many spaces

A person keeps one ace account and one sign-in. Their **personal space** is today's account.
Each active membership is another **space**. Switching spaces never signs anyone in or out.

- **Deciding membership.** When a client asks for anything org-scoped, the backend refreshes the
  session's WorkOS refresh token with `organization_id` (sharing the in-flight refresh as
  `sessions.refreshing_until` does today, and storing the rotated token), verifies the returned
  access token against WorkOS's JWKS, and keeps `{session, org, role, sid, checked_at}` in
  `org_checks`. A check is reused for 60 seconds. If WorkOS refuses, or the mirror says the
  membership is not `active`, nothing org-scoped is granted.
- **When WorkOS refuses** (not a member, the organization needs SSO or MFA this session didn't
  use), the answer is `org_sign_in_required {org}`; the client starts an ADR 0100 sign-in with
  `org`, which the backend passes to the authorization URL as `organization_id`. The new session
  replaces the old one on that client (same account, so nothing else changes). This is how an
  organization's sign-in policy reaches ace without ace enforcing SSO itself.
- **Personal never depends on an organization.** Personal grants never ask WorkOS about
  organizations and never carry an org claim.
- **A domain-managed account.** When the account's email is on a domain an organization
  captures, WorkOS lets that organization's policy decide its sign-in everywhere, and its
  directory can end all its sessions (§6). The switcher says so: "Your account is managed by
  <org>". The join page warns when an account on a personal email would become domain-managed.

#### 1.5 The switcher in every client

- **Desktop and web:** the account menu lists Personal and each organization, with the role. The
  chosen space is per window, kept in the window's state, and shown in the rail's account mark.
  It filters the machine list (`GET /v1/machines?space=…`), Spade's bots and clubs, and adds
  Settings › Organization (§2.7) for admins.
- **iPhone:** the same list in Settings › Account; the drawer shows the current space. M4's
  iPhone scope is switching, shared bots' chats, cards and approvals; admin pages stay desktop and
  web until M4's end.
- **Notices from every space arrive**, labelled with the space; an approval for a shared bot
  opens in that space.
- **Caches are per space.** Every client cache key that holds machine data includes the space,
  so org A's rows are never drawn in org B or in Personal.
- Leaving or being removed from an organization removes the space from the switcher. Nothing is
  deleted: the organization's data stays on its hosts, the person's own data stays on theirs.

### 2. What an organization owns

#### 2.1 Org hosts

An **org host** is a machine whose owner (ADR 0190 §3a) is an organization: the team's
always-on box. A machine has exactly one owner, a person or an organization.

- **Enrolling.** From the machine's own app, signed in, its person-owner chooses Settings ›
  Machine › "Give this machine to <org>". It needs both: the socket's person standing as the
  machine's current owner (`account.owner.release` of ADR 0190, held), and an org grant (2.2) for
  that person with `hosts:manage`. A fresh headless box enrolls with `ace login --org <org>`
  then the first member proof from an admin's device, as ADR 0190's first-owner rule has it.
- **What changes on the machine.** `ace-owner.json` becomes `{kind: "org", org, generation}`.
  The machine credential is reissued bound to this enrollment of the host
  (`machine_credentials.org_id` and `enrollment`; the `machines` row gains `org_id`), and speaks
  for the organization only while that is the host's current enrollment. Another account's
  credential for the machine is never bound.
- **The organization's own credential.** Once the daemon confirms the enrollment it signs in as
  the organization, not as the member who enrolled it, so that person signing out, letting their
  session lapse or being deprovisioned never takes the host off the relay. The backend issues an
  **organization credential** (`machine_credentials.kind = 'org'`, migration 0008): no session
  behind it, its account the organization's principal `org:<org id>`, bound to the enrollment.
  `POST /v1/orgs/{org}/hosts/{hostId}/credential` issues it once per enrollment and renews it for
  30 days, both on the host key's proof alone (`orgHostCredentialProof`, a MAC over host,
  organization, credential and time, taken within five minutes), and only while the organization
  holds the host under that enrollment. It mints only its own host's `machine` grant: never a
  member, device, Spade Cloud or market grant, so it yields no person's standing. The daemon
  keeps it as its sign-in (`source: "org"`), gives the enroller's credential back, renews it with
  the host key, and is signed out once a renewal is refused. A person's handover or `ace login`
  can't replace it while the machine answers to the organization. Every paired device's person standing ends, as any owner
  change does. Nothing on disk is deleted: the person's earlier threads and bots on it stay, and
  stay theirs (2.4).
- **Releasing.** An owner of the organization, from a proven socket, chooses "Release this host";
  or a local reset with the daemon stopped. The next person's proof sets the new owner. Release
  revokes every credential bound to that enrollment, the organization credential included, so the
  machine signs in again before it speaks for anyone.
- **Recommended setup.** A box enrolled from fresh, with the host's sign-ins (git host, mail,
  error tracker) being team service accounts, never a member's personal ones. The guide and
  the enroll page say so, because a shared bot's "send as" is whoever is signed in on the host.

#### 2.2 Member standing and org grants

A member's standing on an org host is proved the way ADR 0190 §3 proves a person's:

```
{ v: 3, kid, kind: "member", aud: "ace-daemon", standing: "member",
  org, role, account, subject, host, key, policy, iat, exp }
```

- Minted by `POST /v1/grants {kind: "member", org, host, key}` only for a `person` session
  (ADR 0190) with a current `org_checks` row (1.4), an `active` mirror row, and `host` listed as
  that org's host. `policy` is the organization's policy version (§3). Lifetime five minutes, as
  every grant.
- Format 1 and 2 parsers refuse `v: 3`, so no older daemon takes it as the person, and a
  machine credential, an `exposed` or `legacy` session can never get one.
- The daemon accepts `account.standing {grant, proof}` with a member grant only when: its owner
  is `org` with the same id and current generation; the grant verifies against the pinned keys;
  it names this host and this socket's device key; the proof signs the socket's nonce and channel
  binding. The socket then has **member standing** with that role until the grant's `exp`; the
  client proves again every few minutes, as today.
- **A personal machine refuses every member grant**, on every socket. An organization, its
  admins and ace's org grants never gain a person's standing on a person's machine.
- Relay admission (ADR 0111) widens by one rule: a `/client?hostId=` connection is admitted when
  the grant's account owns the host, or the grant is a member grant for the org that owns it.

What standing allows on an org host:

| Standing                    | May                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| owner                       | all of admin; `host:shell` (terminal, files outside shared folders, the host's own shell commands), audited each time; release the host                              |
| admin                       | Settings of the host and its Spade; machine code; install and update packages for shared bots; create, configure and move any shared bot; read the audit log         |
| member                      | list and talk to the shared bots they may (2.3); answer approvals where named; create shared bots if the policy allows; their own threads on the host (phase 3, 2.4) |
| no standing (machine grant) | what a machine credential may do today; nothing person-only                                                                                                          |

A machine code (ADR 0111) still applies on an org host and is checked inside the encrypted
channel: recommended for every org host, so a stolen sign-in alone doesn't open it.

#### 2.3 Shared bots and clubs

A **shared bot** is a Spade bot on an org host whose owner is the organization. It keeps an
access list in Spade's store:

| Right       | Who has it by default                                    | What it allows                                                                          |
| ----------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `talk`      | every member (or named members, if its maker narrows it) | message it, read its chat, cards and panels, `@` it in a club or thread of the same org |
| `approve`   | its maker; at least one named member, always             | answer its raised requests (person-only effects, undeclared tools, outside the sandbox) |
| `configure` | its maker and admins                                     | grants, effects switches, routines, model route, access list                            |
| `move`      | admins                                                   | move it between the org's hosts (ADR 0187)                                              |

- **The approvers are the bot's person.** Where ADR 0163 amendment 1 and ADR 0171 decision 2 send
  a call "to the person", a shared bot's call goes to its approvers, as one request all of them
  see; the first answer wins and the others see who answered. Person-only effects stay
  person-only: no grant, policy or role makes them run without an approver's answer each time.
- **An answer carries a member stamp.** Spade takes an answer, a grant, an access change or a
  raise to Full access for a shared bot only with `x-ace-member: v1.<ms>.<nonce>.<account>.<HMAC>`,
  the person stamp of ADR 0163 amendment 2 with the member's account added under the HMAC (same
  key, `spade-person.key`). The daemon's `spade.http` proxy adds it only from a socket with
  member standing whose account holds the needed right on that bot, read from Spade at the time.
  Spade records `answered_by {account, name, role}` on the request and in the audit log (§4).
- **Full access on a shared bot** is off unless the policy allows it (§3), and then only an admin
  with `configure` may raise it.
- **Clubs.** A club led by a shared bot is a shared club; every member bot must be a shared bot
  of the same organization. `talk` on the lead is needed to post. A person's own bot can't join
  an org club, and a shared bot can't join a personal club (cross-space leakage, §8).
- **Contracts** (ADR 0200 §7) are callable only within a space in M4: a shared bot calls
  contracts of the same org's shared bots; a personal bot calls the person's own.
- **The maker leaving** changes nothing about the bot: it is the organization's (§6).

#### 2.4 Projects and threads on org hosts (phase 3)

M4's first slice shares bots only. When coding threads come to org hosts:

- A thread's **owner** is the member who started it; its visibility is `private` (default),
  `org` or named members. Only the owner, and those it names, read a private thread through
  ace. No role, admins and owners included, reads it through ace.
- A project on an org host is visible to every member; starting a thread in it needs `bots:use`.
- **What ace can't promise:** whoever has `host:shell`, or the host's operating-system user, can
  read the host's disk, as ADR 0190's threat model already says. The guide says so: private work
  belongs on members' own machines; org hosts hold shared work.

#### 2.5 Personal machines stay personal

A member's own machines are untouched by their organizations: no org policy applies to them, no
org admin can reach them, no member grant opens them, and nothing about them is reported to the
organization. The one link is a trust the member chooses: installing from their org's private
registry (§5) onto a personal bot.

#### 2.6 Why not FGA in M4

Shared-bot rights are enforced on the org host, where the bots live, and must hold while the
backend is unreachable. Putting them in FGA would make every approval a network check against a
second authority beside the host. WorkOS RBAC carries the org-level role in the token, which is
all M4 needs. Revisit FGA for shared projects at scale (phase 3), where its resource hierarchy
(org › project › thread) fits.

#### 2.7 Organization pages

Settings › Organization, in the space of that organization, for those whose role allows each:

- **Members:** list (mirror), invite, change role, remove; directory-managed rows read-only.
- **Sign-in:** domain verification, SSO, directory: buttons that open Admin Portal links the
  backend generates (`POST /v1/orgs/{org}/portal {intent}`), with `external_user_id` set to the
  admin's account so a removed admin's portal sessions end with them (§6).
- **Hosts:** the org's hosts, their Spade, last seen; enroll and release.
- **Policy** (§3), **Registry** (§5), **Audit log** (§4).

### 3. Admin policy

One policy document per organization, versioned. Admins with `policy:set` edit it; the backend
stores each version in `org_policies` and signs it with the grant key:
`{v: 1, kind: "org-policy", org, version, body_sha256, set_by, set_at}`. Org hosts fetch it on
connect and on a relay nudge, verify it, and apply only a higher version (so an old one can't be
replayed). The current version rides in every member grant; a host that sees a higher one there
fetches it before taking the call.

**A policy only narrows.** It is a ceiling over what the host would allow anyway, so a forged
or wrong policy can at worst refuse things. The only trust that widens, the registry key, is
under a separate rule (§5.3).

```json
{
  "effects": {
    "network_without_hosts": "admins",
    "publish": "approvers",
    "send_as_person": "approvers",
    "pay": "off",
    "change_access": "off"
  },
  "full_access": "never",
  "commands_outside_sandbox": "approvers",
  "members_create_bots": true,
  "packages": {
    "sources": { "market": true, "registry": true, "git": false },
    "mode": "allowlist",
    "allow": [
      { "source": "market", "name": "spade-bot/ci-watcher" },
      { "source": "registry", "name": "*" }
    ],
    "block": [{ "hash": "sha256:…" }]
  },
  "models": {
    "endpoints": ["api.example-models.com"],
    "local": true,
    "subscriptions": false
  },
  "audit": { "content": "digests" }
}
```

- **Effects** (ADR 0171 words). `off`: no shared bot of the organization may use it; the gate
  refuses it the way the package ceiling does (`Not run: Acme doesn't allow paying.`). The
  others say who may turn it on in a bot's switches: `admins`, or `approvers` (the bot's
  configurers). Members never turn on `pay`, `send_as_person` or `publish`; the switch says "Your
  organization lets only admins turn this on." The organization ceiling is one more pure check in
  `spade_core::effect::route`, after the credential refusal and before the package ceiling, so a
  call must pass org ∩ package ∩ grants.
- **Full access and outside-the-sandbox:** `never` or allowed for the listed role, each raise
  still stamped (2.3).
- **Packages** apply to installs and updates onto org hosts. `allowlist` installs only listed
  entries (by source and name, optionally versions); `block` refuses by hash or name and pauses
  a shared bot already running a blocked version, saying why, without removing it. Git catalogs
  are off by default for organizations, since they carry no signature.
- **Models** (ADR 0205): the endpoint hosts and local models shared bots may route to.
  Subscriptions are off for shared bots and can't be turned on in M4: a team bot on one member's
  coding subscription is the case ADR 0205's terms record warns about, and the paid plan never
  depends on one. **Keys never leave the org's hosts:** an admin adds an endpoint key on each org
  host, into that host's keychain (ADR 0119); the backend and the policy hold host names only;
  members see a key's name, never its value; a move leaves keys behind (ADR 0187).
- **Audit content:** `digests` (default: arguments as SHA-256, targets in clear) or `targets`
  only. Never message text, never a member's private thread.
- **Retention.** The WorkOS audit copy's retention is set by owners (`audit:retention`) and can
  only grow, as WorkOS allows. The host's own log and shared bots' history are kept forever by
  default; an owner can delete a shared bot or its history by hand on the host, audited. No
  policy deletes data on its own in M4 (founder rule: only explicit actions delete).

**What admins can see:** membership, roles, hosts, shared bots and their configuration, the
audit log, policy history. **What they can't, through ace:** members' private threads, members'
personal machines, personal bots, personal keys, anything in a personal space.

### 4. The audit log

Two copies with different jobs: a **signed log on each org host**, the record of what its bots
did, and a **WorkOS Audit Logs copy**, the organization's searchable, exportable, streamable view
with a retention the owners set.

#### 4.1 What is logged

| Action                                                                                                                                                                               | Actor                  | Targets                                                        | Metadata (digests, never content)                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot.effect`: every outward effect of a shared bot (`network` write, `publish`, `send_as_person`, `pay`, `change_access`, `git_push`, `pr_comment`, `issue_comment`, `send_message`) | the bot                | bot, host, the effect's target (repo, branch, host, recipient) | `effect`, `allowed_by` (`answer:<request>`, `grant:<id>`, `always:<id>`), `allowed_by_account`, `package`, `version`, `args_sha256`, `entry_sha256` |
| `bot.approval.answered`                                                                                                                                                              | member                 | bot, request                                                   | answer, right used                                                                                                                                  |
| `bot.created`, `bot.configured`, `bot.access_changed`, `bot.moved`, `bot.deleted`                                                                                                    | member                 | bot                                                            | changed fields (names, not values)                                                                                                                  |
| `package.installed`, `package.updated`, `package.rolled_back`, `package.removed`, `package.paused`                                                                                   | member or `policy`     | bot, entry                                                     | source, name, version, hash, effects switched on                                                                                                    |
| `org.policy.changed`                                                                                                                                                                 | member                 | organization                                                   | version, `body_sha256`                                                                                                                              |
| `org.member.invited`, `joined`, `role_changed`, `removed`, `deprovisioned`, `reactivated`                                                                                            | member, `idp` or `jit` | member                                                         | role before and after                                                                                                                               |
| `org.host.enrolled`, `org.host.released`, `host.shell_opened`                                                                                                                        | member                 | host                                                           |                                                                                                                                                     |
| `registry.published`, `registry.withdrawn`, `registry.key_rotated`                                                                                                                   | member                 | entry or key                                                   | version, hash, key id                                                                                                                               |
| `audit.checkpoint`                                                                                                                                                                   | host                   | host                                                           | chain head, count, signature                                                                                                                        |

"Who allowed it" is always a person: an answer names its approver; a grant names the member who
made it (`by` in ADR 0167 §5 becomes `{member: <account>}` for shared bots); an Always allow
names who set it. An effect with no human allower can't happen on a shared bot: the gate has no
path for one.

#### 4.2 The host's log

- **Where.** Spade's store on the org host, append-only table `org_audit`, written in the same
  transaction as the event it records (the call's `approval_answered`, `call_ran`), so a crash
  never leaves an effect without its entry. The daemon writes its own rows (membership seen,
  host shell, enrollment) through Spade's loopback API.
- **Tamper evidence.** Each entry carries the SHA-256 of the one before. Every 100 entries or
  five minutes, whichever comes first, the host signs a checkpoint (chain head, count, time) with
  an Ed25519 **audit key** kept in the host's keychain and registered with the backend at
  enrollment (`org_hosts.audit_key`). The checkpoint goes to WorkOS as `audit.checkpoint`. A
  rewrite of anything before the last checkpoint no longer matches a signature held outside the
  host. Residual: someone with `host:shell` or the OS user can change entries newer than the last
  checkpoint, at most five minutes' worth, before it is sent.
- **Export and verify.** `ace org audit export --from --to` writes JSON Lines with the chain and
  checkpoints; `ace org audit verify <file>` checks the chain and each checkpoint against the
  host's registered key, offline. Admins get the same from Organization › Audit log.

#### 4.3 The WorkOS copy

- The host forwards each entry to `POST /v1/orgs/{org}/audit` with its machine credential; the
  backend checks the host is the org's and calls WorkOS `createEvent` with `idempotency-key` set
  to the entry's hash, so retries and replays after a restart never duplicate. Forwarding is an
  outbox: an offline host catches up in order when it reconnects.
- The backend writes its own events (membership, policy, invitations, portal links) directly.
- Schemas for every action are configured in WorkOS with metadata validation on; a change makes a
  new schema version, and entries name the version they were written for.
- **Export:** WorkOS CSV exports (31 days each) from the Admin Portal `audit_logs` intent or
  Organization › Audit log; **streaming:** Log Streams through the `log_streams` intent. Default
  retention for organizations: one year, set by ace at creation; owners may raise it.

### 5. Private registries

#### 5.1 The registry on the market

- An organization gets an **org publisher** on market.acehq.dev, handle `<org-handle>`, under
  ADR 0174's handle rules, with `kind: "org"` and `org_id`.
- Its entries have visibility `org:<id>`. Search, listings, versions, archives and withdrawals
  for them answer only to a market grant with `org` and an active member's account
  (`MarketGrantClaims` gains optional `org`, minted only after the 1.4 check). Everyone else gets
  404, never 403, so the entry's existence doesn't leak. Org entries never appear in Featured,
  categories, trending or another organization's search.
- **Who may publish:** members whose role holds `registry:publish` (admins by default; an owner
  may add named members as registry publishers). Every write is ADR 0174 §2's, with the org claim.
- **Scanning applies unchanged** (ADR 0174 §8): the same fail-closed pipeline, the same holds. A
  version that fails is never offered to the signer.
- Storage follows ADR 0174 §16: org entries live in their type's database with a visibility
  column (a constant default, no rewrite); registries, publishers' rights and the key chain live
  in one new shared-domain database, `market-orgs`.

#### 5.2 The organization's signing key

- Each organization has its own Ed25519 **registry key**, made and kept in the keychain of one
  machine the owners choose: an org host (recommended, so it signs while people sleep) or an
  owner's own machine. It never reaches ace's servers.
- That machine runs the org signer (`ace org registry sign`, or the host's signer loop), which
  does for the organization what ADR 0168 §6's signer does for the market: pulls versions that
  passed the scan, runs the checks again on the bytes from R2, signs the manifest with
  `registry: <org>` and the key id, and uploads the signature. A version is offered only once
  signed. Withdrawals are signed the same way.

#### 5.3 How devices trust it

- **Key chain.** The registry's keys form a chain: the first key is published by an owner from a
  proven socket and countersigned by the backend's grant key; each later key is accepted only
  with a rotation statement signed by the key before it. The market serves the chain
  (`GET /v1/orgs/{org}/keys`), and devices pin it.
- **First trust, on each device,** is the member's choice on the first install review: "Acme's
  registry, key ab12…, added by <owner> on <date>. Trust it for installs on this machine?" A
  chain that breaks (a new first key, as after losing the key) is never followed silently: every
  device shows "Acme's registry key was reset by <owner>" and asks again.
- **Install needs membership, on the device, at the time.** The daemon accepts an org-signed
  manifest only with a fresh org check (1.4) that this machine's signed-in account is an active
  member, so a package from Acme's registry is refused on a device outside Acme even if its
  archive is copied there. A compromised backend that mints a membership answer still can't sign
  a package; a stolen registry key still can't install anything without a member's review.

#### 5.4 Install and update

The ADR 0168 §8 flow, with the source "Acme registry":

- **Onto an org host:** an admin, or a member with `bots:create` for an allowlisted package,
  prepares, reviews and accepts it. The policy's package rules and organization ceiling apply on
  the review; switches above the member's role are locked.
- **Onto a member's personal machine:** the member, for a personal bot, as for any market entry;
  the org's policy doesn't apply there (2.5).
- **Updates** stay linked (ADR 0200 §3.9): a new signed version is offered; one that declares
  more effects is reviewed again; rollback works as for the market. A member who leaves keeps
  what they installed on their own machines, labelled "From Acme registry · updates stopped:
  you're no longer a member".

### 6. Deprovisioning

When a member is removed (Members › Remove), deprovisioned by the directory, or their membership
goes `inactive` or is deleted:

| What                                       | What happens                                                                                                                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Org grants                                 | The events consumer marks the mirror row within a minute (cron, Events API cursor); the 60 s check refuses at once on WorkOS's answer. No member grant is minted after that.                                                                 |
| Open sockets to org hosts                  | Close when their grant runs out with no fresh one: at most five minutes plus ADR 0111's 30 s grace.                                                                                                                                          |
| Answers in flight                          | A member stamp counts only while the socket's member standing is current, so an answer after the grant ran out is refused.                                                                                                                   |
| Requests they were the approver of         | Stay open for the bot's other approvers. A bot left with no active approver keeps its person-only requests waiting and tells admins "CI watcher has no approver"; nothing runs in the meantime.                                              |
| Shared bots they made, hosts they enrolled | Stay the organization's. Their rights on bots are marked inactive, not deleted, and come back if the membership is reactivated (WorkOS keeps the role).                                                                                      |
| Admin Portal sessions                      | Revoked with `external_user_id` = their account, whatever role the mirror showed: queued with the mirror's change, retried by the minute cron until WorkOS confirms.                                                                         |
| Their threads on an org host (phase 3)     | Kept, private, owned by a former member; an owner may transfer them or delete them by hand, audited.                                                                                                                                         |
| Keys                                       | Nothing to revoke on their machines: the organization's endpoint keys live only on org hosts, and the registry key on the signer's machine. If the signer machine was the leaver's, owners rotate the registry key from a new machine (5.3). |
| Their personal space                       | Untouched and never deleted: their account, machines, bots, threads and local data stay.                                                                                                                                                     |

**One WorkOS behaviour reaches further.** Deactivation (and so SCIM deprovisioning) revokes all
of the user's WorkOS sessions, personal included. ace sees an invalid grant on its next refresh
and ends those ace sessions and the machine credentials living on them (ADR 0100, ADR 0190), so
the person's own machines show "Signed out" and keep working locally, over LAN and pairing, until
they sign in again. Their data is untouched. For this reason ace's own Remove **deletes** the
membership instead of deactivating it, keeping a `removed` row in the mirror for history; the
directory's deprovisioning can't be changed and is shown on the join page for domain-managed
accounts (1.4). A test on WorkOS staging confirms that deleting a membership leaves the person's
other sessions alone before Remove ships.

### 7. Billing hooks, not built

- `orgs.plan`: `pilot` (default during M4) or `team`; `orgs.seats` is the count of `active`
  memberships, read from the mirror.
- One pure function in the backend, `planAllows(plan, feature)`, gates the M4 features (shared
  bots, policy, audit, SSO and SCIM portal links, registry); in M4 every plan allows all.
- The `billing` role and `billing:manage` permission are defined and assigned to nobody.
- When billing comes (M6, its own ADR): a lapsed plan makes the organization's features
  read-only (no new shared bots, members, publishes), keeps the policy enforced as it is (a lapse
  never loosens it), and deletes nothing.

### 8. Security

#### 8.1 Threats

| Threat                                           | What holds                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A malicious admin**                            | Can narrow policy, invite, change members' roles below owner, configure shared bots. Can't: reach any personal machine (member grants refused there), read private threads through ace, approve on a bot without being named (adding themselves is `bot.access_changed`, audited, and every other approver is told), open a shell on a host (`host:shell` is owners'), change the registry key, delete audit entries. |
| **A malicious or hijacked owner**                | Holds the organization: hosts, shared bots, policy, registry key. Still can't reach members' personal machines or spaces. Every step is in the host's signed log and the WorkOS copy, which they can export but not edit.                                                                                                                                                                                             |
| **A compromised identity provider or org**       | Can make members and admins. Bounded the same way: the organization's own hosts and bots only. Recovery is the organization's (directory, SSO), plus rotating the registry key and releasing hosts.                                                                                                                                                                                                                   |
| **Member impersonation**                         | Member standing needs the browser sign-in, a key in the client's memory and the socket's channel binding (ADR 0190 §3). A reader of an org host's `ACE_HOME` holds the machine credential, which never mints member grants. Approvals need a member stamp the daemon adds only from a proven socket with that right.                                                                                                  |
| **Cross-org and cross-space leakage**            | Every org row and route is keyed by org id and checked against the grant's org; a host checks its owner's org against every grant; clubs, contracts and moves stay inside one space; market org entries answer 404 outside the org; client caches are keyed by space; audit metadata holds digests, not content.                                                                                                      |
| **A compromised ace backend**                    | Can mint member grants and market org claims, as it can mint person grants today (ADR 0111's consequence). Machine codes on org hosts stop a grant alone. It can push a policy, which only narrows. It can't sign packages, change a pinned registry key chain, or rewrite a host's checkpointed log.                                                                                                                 |
| **A compromised org host**                       | Owns its bots, history and keys, and the registry key if it is the signer; can rewrite its log back to the last checkpoint. Can't reach other hosts or personal machines. Owners release it and rotate the key.                                                                                                                                                                                                       |
| **Invitation phishing and domain capture abuse** | WorkOS makes the invitee choose; ace's join page names the organization and inviter and spends nothing until "Join". Domain capture needs DNS proof; consumer domains are refused.                                                                                                                                                                                                                                    |
| **Late deprovisioning**                          | Bounded to the 60 s check plus one grant lifetime and its grace. A host also asks the backend for the member's status when an approval for a person-only effect arrives older than 60 s on its socket.                                                                                                                                                                                                                |

#### 8.2 Tests

Behaviour tests through public surfaces, at the right tier:

- **Backend (process tests on a local Worker with D1, WorkOS faked at its HTTP edge):** a member
  grant is minted for an active member and refused once WorkOS refuses the organization refresh;
  refused for an `exposed` session and for a machine credential; `org_sign_in_required` when
  WorkOS refuses for SSO; the last owner can't be removed; an Events API page that deactivates a
  member stops grants within the next check; the events cursor resumes after a restart without
  skipping or repeating; audit forwarding with the same entry twice writes one WorkOS event.
- **`@ace/account-grant` (unit, test vectors):** a `v: 3` member grant verifies; format 1 and 2
  parsers refuse it; a member grant can't be respelled.
- **Daemon (process):** a personal machine refuses a member grant on every socket; an org host
  accepts one for its org and refuses another org's; member standing ends at `exp`; enrolling
  needs both the owner's standing and `hosts:manage`; a member stamp is added only for a member
  with the right; an approval answered after deprovisioning is refused.
- **Spade (`cargo test`):** the organization ceiling refuses an `off` effect before the package
  ceiling; a member can't turn on `pay`; a shared bot's person-only request waits for an approver
  and runs only on a stamped answer; every outward effect writes an `org_audit` entry in the same
  transaction; a chain edit fails `verify`; a checkpoint signature mismatches after a rewrite; a
  club refuses a personal bot; a policy with a lower version is ignored.
- **Market (process):** org entries 404 to non-members and to other orgs' members; scanning holds
  an org version; a manifest signed by an unknown or broken-chain key is refused on the device; a
  device whose account isn't a member refuses an org-signed archive copied to it.
- **Clients (jsdom):** switching spaces never draws another space's machines or bots; leaving an
  organization removes its space and deletes no local data; locked switches say why.
- **On WorkOS staging, by hand, before each phase ships:** SSO-required refresh refusal; SCIM
  deprovisioning revokes sessions; membership deletion leaves other sessions; Admin Portal
  revocation by `external_user_id`.

### 9. Phases

1. **First slice: one team, one host, one shared bot, every effect on record.**
   - Backend: orgs, memberships, roles, invitations, the join page, the events mirror, org
     checks, member grants, org hosts, the policy (effects part only), audit forwarding,
     Admin Portal links for SSO and domain verification.
   - Daemon: org owners, member standing, enrollment, relay admission, the member stamp.
   - Spade: shared bots with access lists, approvers, the organization ceiling, the signed host
     log with checkpoints.
   - Desktop and web: the switcher, Members, Sign-in, Hosts, Policy (effects), Audit log.
   - **Done when:** a five-person organization on staging runs the CI watcher on one org host for
     seven days; every outward effect's audit entry names the member who allowed it; a removed
     member's sockets close within six minutes; `ace org audit verify` passes on the export.
2. **The rest of M4.** SCIM (Directory Provisioning), package and model policy, private
   registries with the org signer and key chain, iPhone switcher and approvals, Log Streams.
   **Done when:** M4's exit criterion (product plan) holds.
3. **After M4.** Threads and projects on org hosts (2.4), FGA for them if it fits, giving a
   personal bot to an organization (a move with a clean consent slate), contracts across spaces.

## Decided

- ace's organization is a WorkOS organization; roles are WorkOS environment roles, mapped to
  permissions by ace's own table; unknown roles act as `member`.
- Membership for anything org-scoped is decided by a WorkOS refresh with `organization_id`, at
  most 60 seconds old; the D1 mirror only lists and refuses faster.
- Org hosts are owned by an organization; personal machines refuse every member grant.
- Shared bots live only on org hosts; their approvers are their person; answers carry a member
  stamp.
- Policy only narrows; it is signed by the backend and versioned; the registry key is the one
  widening trust and has its own chain.
- Audit: a hash-chained, checkpointed log on each host, mirrored to WorkOS Audit Logs with
  idempotency; one year of WorkOS retention by default.
- Private registries: org publishers on the market, org-only visibility, unchanged scanning, the
  organization's own key on its own machine, installs refused without current membership.
- Shared bots never use coding subscriptions in M4.
- ace's Remove deletes the membership; directory deprovisioning is WorkOS's and its reach is told
  to the person.
- No FGA in M4.

## For the founder

1. **Who may create an organization in M4.** Recommended: anyone signed in with a verified email,
   free on the `pilot` plan until M6; the alternative is invited pilots only.
2. **SSO and SCIM cost.** WorkOS bills SSO and directory connections per organization.
   Recommended: they come with the Team plan (one of each), free for the M4 pilot teams.
3. **Turning on Directory Provisioning.** It must be requested from WorkOS support for ace's whole
   WorkOS team, before any customer directory exists, and only support can turn it off.
   Recommended: request it on staging now, on production when phase 2 starts.

## Options considered

- **ace's own org tables, WorkOS only for sign-in.** Rejected: SSO, SCIM, domain capture and
  audit export would all be built twice, and roles from directory groups would never reach ace.
- **FGA for every shared-bot right.** Rejected for M4 (2.6).
- **Shared bots on members' own machines.** Rejected: an organization would then need rights on
  personal machines, which is the line this ADR keeps.
- **Audit only in WorkOS.** Rejected: an offline host would lose entries, retention starts at 30
  days, and nothing outside ace's backend would vouch for it. Only on the host: rejected, no
  search, export or streaming for compliance teams.
- **Org policy signed by an admin's device key.** Rejected: device keys live in one window's
  memory and can't sign across sessions; a narrowing-only policy makes the backend's signature
  enough.
- **Registry key held by ace.** Rejected: ADR 0168 keeps signing keys off ace's Workers, and an
  organization's catalog should be its own word.

## Consequences

- The backend grows a WorkOS events consumer (cron, cursor in D1), five tables
  (`orgs`, `org_members`, `org_checks`, `org_hosts`, `org_policies`) and one column each on
  `machines` and `machine_credentials`, all additive with constant defaults (ADR 0170).
- A domain-managed account's sign-in belongs to its organization, and its directory can sign the
  person out of their personal space too. ace says so before the person joins.
- Org hosts become the place where ace's "who is the person" question has more than one answer;
  everything person-only on them goes through approvers and stamps.
- Running an org host means keeping its keychain, its sign-ins and its registry key; the guide
  covers backup and rotation.

## Verification

None yet: this is a design. Each phase's done line (§9) is its verification.
