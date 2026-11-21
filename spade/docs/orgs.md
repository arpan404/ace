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

## The member stamps

ace's daemon adds a member's stamp only from a socket whose member standing is current. It holds
no access list, so it stamps any current member: Spade checks the member's right on the bot
itself (`security::member`). Both stamps use the person stamp's key (`spade-person.key`), in
domains of their own, so none stands in for another or for a person's.

**An answer** to a shared bot's request, as the daemon makes it (ADR 0206 WP2,
`apps/daemon/src/spade/member-stamp.ts`; `src/security/member-vector.json` is its output):

```
x-ace-member: v1.<ms>.<nonce>.<account>.<hex HMAC-SHA256>
message:      ace-spade-member/1\n<target>\n<value>\n<account>\n<ms>\n<nonce>
target:       approval:<conversation>:<call>   or   outside:<conversation>:<ask>
value:        allowed=<bool>;always=<bool>
```

It carries no role, so Spade reads its member as `member`: an approver answers, but where the
policy keeps letting commands run outside the sandbox for admins, an answer stamp can't.

**Any other write** to a shared bot, as the daemon makes it for every write of a socket whose
member standing is current (`memberRequestStamp` in `apps/daemon/src/spade/member-stamp.ts`;
the vector's `requests` are its output). An unstamped write to a shared bot is refused:

```
x-ace-member-request: v1.<ms>.<nonce>.<account>.<hex HMAC-SHA256>
x-ace-member-role:    <role slug from the member grant>   (signed; absent is signed as member)
message: ace-spade-member-request/1\n<METHOD> <path>\n<hex SHA-256 of the body>\n<account>\n<role>\n<ms>\n<nonce>
```

`<path>` is the full path sent (`/v1/agents/a_1/grants`), without the query. `x-ace-member-name`
is recorded only. Every stamp is good for 60 s either side of Spade's clock, and once. A body
sent to Spade in parts (`spade.http.part`) isn't stamped: the stamp is made before the body is
read, so such a write to a shared bot is refused.

Which right a write needs (`api::org_guard`):

| Write                                                      | Stamp   | Right                                                            |
| ---------------------------------------------------------- | ------- | ---------------------------------------------------------------- |
| `POST /v1/conversations/{c}/approvals/{call}`              | answer  | `approve` (and the policy's outside rule)                        |
| `POST /v1/conversations/{c}/plugin_outside/{ask}`          | answer  | `approve`; only a no is taken                                    |
| `PUT /v1/agents/{id}/access`                               | request | `configure`                                                      |
| `POST /v1/agents/{id}/move`                                | request | `move` (admins)                                                  |
| `PUT /v1/agents/{id}/security/autonomy` to Full access     | request | the policy's leave, an owner or admin who configures it          |
| any other write under `/v1/agents/{id}/`                   | request | `configure`                                                      |
| any other write under `/v1/conversations/{c}/` (a message) | request | `talk`                                                           |
| `POST /v1/groups/{id}/messages`, `/stop` of a shared club  | request | `talk` on its lead                                               |
| any other write to a shared club                           | request | `configure` on its lead                                          |
| `PUT /v1/moves/{id}/accept` on an org host                 | request | an owner's or admin's                                            |
| `POST /v1/org/bots {name, task, model?}`                   | request | any member; admins only unless the policy lets members make bots |

The daemon can read a bot's list (`GET /v1/agents/{id}/access`) to refuse early.

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
`send_as_person` or `publish`. Full access needs the policy's leave (`full_access: admins` or
`approvers`) and an owner or admin who configures the bot, stamped; even then no outward step
runs without a member's say (above). A shared bot's step fails, saying why, when its model is a
coding subscription or an endpoint the policy doesn't list.

Packages on an org host (any bot, shared or not): an install (`POST /v1/agents` with a package)
and an update or rollback (`POST /v1/agents/{id}/package`) are refused (`403`, the policy's
words) when `Policy::package_refusal` refuses the version; a template this Spade ships reads as a
market package, a local one (signed by nobody) as a git catalog's. Applying a policy that blocks
a version a bot runs pauses that bot with the one pause a withdrawal uses, saying why, as the
policy's step (`package.paused`); its version isn't marked never to move to again, and neither
Resume (`DELETE …/package/withdrawn`, `POST …/resume`) takes while the block stands. Turning a
shared bot's switch on (`PUT …/package/effects`) is held to `Policy::switch_refusal` for the
stamped member's role; turning one off always narrows.

`PUT /v1/org/policy` takes a version as the backend serves it (`AceOrgPolicyVersion`). It is
applied only when its statement verifies with the pinned grant keys (Ed25519,
`signOrgPolicy`'s format; `src/org/policy-vector.json` is one the backend made), is over this
exact body, names this organization, and is newer than the one held: `409` otherwise.

## The audit log

`org_audit` in Spade's store, append-only (SQLite refuses an update of an entry or a delete),
each entry chained to the one before (`spade_core::org::audit::hash`). Entries are written in
the same transaction as what they record:

| Entry                                                                                               | Written with                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `bot.effect`                                                                                        | the call's `tool_started`, before it runs: a step whose entry can't be written never runs                         |
| `bot.approval.answered`                                                                             | the `approval_answered` event                                                                                     |
| `bot.created`, `bot.access_changed`                                                                 | the bot's `org_bot:` setting                                                                                      |
| `package.installed`, `.updated`, `.rolled_back`, `.paused`, `.removed`, a switch's `bot.configured` | the bot's package link, whichever path writes it (`spade_store::Store::watch_settings`, `spade_core::org::steps`) |
| `bot.deleted`                                                                                       | the bot's deletion, for a shared bot                                                                              |
| `bot.moved`                                                                                         | the source's move going on to `finishing`: the other host holds it committed                                      |
| `bot.configured`                                                                                    | after a stamped configure write to a shared bot succeeded (see below)                                             |
| `audit.checkpoint`                                                                                  | the checkpoint row                                                                                                |

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

Each entry names who took the step: the member whose stamp asked (`org::acting`), the policy,
or the host itself for a step it took on its own (an update held for the bot's still moment).

## The daemon's side

ace's daemon (`apps/daemon/src/org-host/`) gives this Spade to the machine's organization as the
machine takes in its enrollment (`PUT /v1/org`, stamped as the machine's own say, with the grant
keys its build pins) and lets it go on release; fetches the organization's signed policy with the
host's credential on a schedule, on a sign-in change and when a member grant names a newer
version, and offers it here; and drains the outbox to `POST /v1/orgs/{org}/audit` in order,
moving on past an entry the backend refuses for good (`422`) and stopping to retry later on
anything else. `ace org audit export` and `ace org audit verify` call the export route and
`--verify-org-audit`.

## Not built yet

- `bot.configured` for a configure write other than a switch is written right after the write
  succeeds, not in its transaction: a bot's configuration spans many tables. A crash between the
  two loses that entry.
- A bot installed on an org host isn't made a shared bot by installing it; only
  `POST /v1/org/bots` makes one.
- A blocked version pauses its bots right after the policy that blocks it is applied, not in
  that write: a crash in between leaves them running until the next policy. A bot that moves in
  on a blocked version isn't paused on arrival.
- Creating a club of shared bots needs no stamp (posting to it does).
- Telling admins a shared bot has no active approver; rights of deprovisioned members are the
  daemon's to withhold (no stamp), not marked inactive here.
