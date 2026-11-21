# Spade on an org host

[ADR 0206](../../docs/adr/0206-organizations-on-workos.md) §2–§4, as Spade builds them: a Spade
given to an organization, its shared bots and their access lists, the organization's policy as a
ceiling in the gate, and the host's audit log. ace's daemon proves who a member is (member
standing, ADR 0206 §2.2) and stamps what it forwards; Spade checks every stamp and every right
again itself.

## Giving a Spade to an organization

`PUT /v1/org {org, name, host, keys}` with the owner's person stamp (`x-ace-person`,
`security::attest`) over target `org` and value the org's id. `keys` are the account backend's
grant keys (`GET /v1/keys`), which the policy is verified with. A Spade given to another
organization is let go first: `DELETE /v1/org`, stamped with value `none`. Letting go deletes
nothing: shared bots stay, held to nothing outward, and stay the organization's.

`GET /v1/org` answers `{org, name, host, policy, auditKey, auditKeyProblem}`. `auditKey` is the
host's Ed25519 audit key, base64url, which enrollment registers (`org_hosts.audit_key`). Its seed
lives in the keychain (`spade-keys`, account `org-audit:<org>`) and is made on first use.

## The member stamp

Every write to a shared bot carries the daemon's stamp of the member who asked, over the request
itself, so the daemon stamps any request it forwards without knowing each route:

```
x-ace-member:      v1.<ms>.<nonce>.<account>.<hex HMAC-SHA256>
x-ace-member-role: <role slug from the member grant>      (signed; absent is signed as member)
x-ace-member-name: <name>                                 (recorded only; never authorizes)

HMAC key:  spade-person.key (the person stamp's key)
message:   ace-spade-member/1\n<METHOD> <path>\n<hex SHA-256 of the body>\n<account>\n<role>\n<ms>\n<nonce>
```

`<path>` is the full path the daemon sends (`/v1/conversations/c_1/approvals/k_1`), without the
query. The stamp is good for 60 s either side of Spade's clock and once (its nonce is claimed with
the person stamps'). A person stamp is never a member's, and counts for nothing on a shared bot.

Which right a write needs (`api::org_guard`):

| Write                                                         | Right                                       |
| ------------------------------------------------------------- | ------------------------------------------- |
| `POST /v1/conversations/{c}/approvals/{call}`                 | `approve` (and the policy's outside rule)   |
| `PUT /v1/agents/{id}/access`                                  | `configure`                                 |
| `POST /v1/agents/{id}/move`                                   | `move` (admins)                             |
| any other write under `/v1/agents/{id}/`                      | `configure`                                 |
| any other write under `/v1/conversations/{c}/` (a message)    | `talk`                                      |
| `POST /v1/groups/{id}/messages`, `/stop` of a shared club     | `talk` on its lead                          |
| any other write to a shared club                              | `configure` on its lead                     |
| `PUT /v1/moves/{id}/accept` on an org host                    | an admin's stamp                            |
| `POST /v1/org/bots {name, task, model?}`                      | any member, admins only unless the policy lets members make bots |

The daemon reads a bot's list (`GET /v1/agents/{id}/access`) to decide whether to stamp at all.

## Shared bots and their access lists

A shared bot is made by `POST /v1/org/bots`; its record is the setting `org_bot:<id>`
(`spade_core::org::Access`), which moves with it. Its maker approves and configures it; every
member talks to it. Approving is by name only: no role approves for a bot that doesn't name it.
Configuring is the maker's, the named configurers' and admins'; moving is admins'. A list always
keeps one approver. Workers and helpers of a shared bot are in its space and answer to its list.

An answer to a shared bot's request is taken only from one of its approvers and recorded on the
`approval_answered` event as `by: {account, role, name}`. A plugin's request to run outside the
sandbox is never allowed on a shared bot.

## The organization ceiling

`spade_core::org::gate`, called by `effect::route` after the credential refusal and before the
package ceiling, for a shared bot's call:

- an effect the policy turns `off` is refused in every mode (`Acme doesn't allow paying.`);
  `network_without_hosts` rules what reaches outside without the sandbox's host list;
- `commands_outside_sandbox: never` refuses a command outside the sandbox;
- Full access holds only while the policy allows it; a bot raised before decides on the
  auto-review;
- an outward step (`network`, `publish`, `send_as_person`, `pay`, `drive`, `change_access`) that
  would run with no member's say (the reviewer's verdict, Full access) goes to its approvers. A
  member's grant or an approver's Always allow is a say.

The policy (`spade_core::org::Policy`) is read leniently and authorizes strictly: a word this
build doesn't know reads as the narrowest rule of its kind. Members never turn on `pay`,
`send_as_person` or `publish`; Full access needs the policy's leave and the listed role. A
shared bot's step fails, saying why, when its model is a coding subscription or an endpoint the
policy doesn't list. Package rules (`package_refusal`, `blocked`) are pure and tested; installs
don't call them yet (below).

`PUT /v1/org/policy` takes a version as the backend serves it (`AceOrgPolicyVersion`). It is
applied only when its statement verifies with the pinned grant keys (Ed25519,
`signOrgPolicy`'s format; `src/org/policy-vector.json` is one the backend made), is over this
exact body, names this organization, and is newer than the one held: `409` otherwise.

## The audit log

`org_audit` in Spade's store, append-only (SQLite refuses an update of an entry or a delete),
each entry chained to the one before (`spade_core::org::audit::hash`). Entries are written in
the same transaction as what they record:

| Entry                   | Written with                                                                      |
| ----------------------- | --------------------------------------------------------------------------------- |
| `bot.effect`            | the call's `tool_started`, before it runs: a step whose entry can't be written never runs |
| `bot.approval.answered` | the `approval_answered` event                                                     |
| `bot.created`, `bot.access_changed` | the bot's `org_bot:` setting                                          |
| `audit.checkpoint`      | the checkpoint row                                                                |

`bot.effect` names `effect`, `allowed_by` (`answer:<call>`, `always:<call>`, `grant:<id>`),
`allowed_by_account`, `tool`, `args_sha256` (unless the policy keeps targets only), and
`package`/`version` for a packaged bot. A call is recorded when it is outward, declares nothing,
or an approver answered it. Never message text or arguments.

Every 100 entries or five minutes, the host signs a checkpoint over the chain's head with its
audit key (`spade-org-audit-checkpoint/1\n<org>\n<host>\n<count>\n<head>\n<at>`), kept beside
the chain and recorded as `audit.checkpoint`, which the outbox carries out.

- `POST /v1/org/audit {entries}`: the daemon's own rows (membership seen, a host shell,
  enrollment); `bot.*` and `audit.checkpoint` are Spade's alone.
- `GET /v1/org/audit/outbox?limit=` and `POST /v1/org/audit/forwarded {through}`: the daemon
  forwards each entry to `POST /v1/orgs/{org}/audit` with its machine credential, in order, then
  marks them taken; an offline host catches up in order.
- `GET /v1/org/audit/export?from=&to=`: JSON Lines (`header`, then `entry` and `checkpoint`),
  for `ace org audit export`.
- `spade --verify-org-audit <file> <key>`: checks an export offline against the registered key,
  for `ace org audit verify`; exits 0 only when it verifies.

## Spaces

A club takes bots of one space (a shared club doesn't take Spade, the person's own, as its
lead); a contract is called only inside one space, and a shared bot neither calls nor takes a
call from another machine; a shared bot moves only to its organization's hosts, checked where it
leaves (the machine list's `org`) and where it arrives (the manifest's `bot.org` against the
host's own), and a personal bot never moves onto an org host.

## Not built yet

- The daemon side (WP2): member standing, adding the stamp, forwarding the outbox, fetching the
  policy, `ace org audit export|verify` calling the routes and flag above.
- Package policy on installs and updates onto an org host, and pausing a running bot whose
  version the policy blocks: the rules are in `Policy`, not called from the install path.
- Switch changes on a packaged shared bot checked against `Policy::switch_refusal` (today any
  configurer's stamp changes them).
- `bot.configured`, `bot.moved`, `bot.deleted` and `package.*` entries; a shared bot deleted
  by a configurer is not audited.
- Creating a club of shared bots needs no stamp (posting to it does).
- Telling admins a shared bot has no active approver; rights of deprovisioned members are the
  daemon's to withhold (no stamp), not marked inactive here.
