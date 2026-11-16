# 0171: Spade decides on effects, not words

Status: accepted. Date: 2026-11-16. Decided by: the owner (2026-11-16: the access classifier is
unreliable, "half the time it doesn't work"; decide on effects, not words, and let the person
run a command outside the sandbox). Amends [ADR 0163](0163-spade-auto-review-only.md)
(decision 2 and amendment 1) and [ADR 0167](0167-spade-security-boundaries.md) (decisions 2,
4, 5, 8 and 10). The contract is in [spade/docs/security.md](../../spade/docs/security.md) and
[spade/docs/autonomy.md](../../spade/docs/autonomy.md).

## Context

The auto-review guesses what a call does from its text. Tool names and the first words of their
descriptions are split into words and matched against lists (`send`, `pay`, `key`, `update`…),
and shell commands go through a parser and a classifier with its own lists. What the guess
misses or can't read goes to a reviewer model, which can be slow, cut off or wrong. The guess
misses AppleScript here-documents, flags harmless names (`update_sort_order` reads as an edit
that acts, `invite_member` as a credential change), and the same call can land differently as
the lists change. Meanwhile ADR 0167 built the boundary the guess was standing in for: on macOS a
bot's commands run in a Seatbelt sandbox with no credentials and network only through the egress
proxy.

So the guess sits in front of a boundary that already decides, and the things the boundary can't
see (a send in the person's name, a payment, a push) are exactly the ones a word list is worst
at. The rule has to be fast, the same input has to get the same decision, and every rule has to
fit in a table.

## Decision

1. **The sandbox enforces.** A `shell` command, a terminal command, an owned service and a plugin
   MCP call that runs in a working sandbox (macOS, when the probe passes and the proxy listens)
   gets no classifier and no reviewer. It runs. The OS boundary decides what it can do: write
   only to the workspace and granted folders, read no credentials, drive no other app, reach the
   network only through the proxy's policy. The shell word lists, the parser and the credential
   word list are not run on that path. Plugin hooks were never gated and stay so.
2. **Credentials never enter the sandbox, so an effect that leaves the box goes through a typed
   tool that holds the credential.** Spade adds four tools that run outside the sandbox with the
   person's own sign-ins, each with structured arguments and each starting a fixed program with
   arguments, never a shell:
   - `git_push {branch, remote?, path?}`: the bot's commits are fetched into a clean repository
     Spade owns, and pushed from there to the remote's URL (`https://` or ssh only) with the
     repository's hooks and configuration left out, so nothing the bot wrote runs with the
     person's keys;
   - `pr_comment {repo, number, body}` and `issue_comment {repo, number, body}`: `gh` in a folder
     of Spade's, the body on stdin;
   - `send_message {app, to, body, subject?}`: Messages or Mail on macOS, the text passed as
     script arguments, never as script text.

   Decisions on them are exact:
   - sending as the person (`send_message`, `pr_comment`, `issue_comment`, a connector tool
     declared as a send) and payments always go to the person, as a raised request. The one
     exception is a `pr_comment` grant, which the person made for that repository;
   - `git_push` to a branch a `git_push` grant covers runs; any other push goes to the person.
     Under untrusted content a covered push is reviewed with the grant named (ADR 0167
     decision 5, kept until per-value provenance);
   - publishing is reviewed;
   - the person's Always allow still applies as today.

   Publishing has no tool of its own in this pass: it is the effect a connector or plugin tool
   declares (a release, a deploy), and a command outside the sandbox. Paying has none either:
   Spade has no payment provider, so it is the effect a connector declares (the shipped catalogue
   marks PayPal, Square and Stripe writes as payments) and the one argument rule below. Nothing
   here adds a provider.

3. **Every tool declares its effect once:** `read`, `write_local`, `network`, `publish`,
   `send_as_person`, `pay`, `change_access` or `credential`.
   - Spade's built-in tools come from one table in `spade_core::effect`.
   - ace's tools come from ace's own risk (read, or `network`), and one argument rule: a
     `browser_*`, `screen_*` or `sim_*` call told to press a purchase button (`Place order`,
     `Buy now`…) is `pay`. It reads the pressed label, never a tool name.
   - Connector and plugin MCP tools use their annotations: `readOnlyHint: true` is `read`, any
     other annotation is `network`. An effect declared for the tool wins: per tool, or for every
     write of one connector, in the connector catalogue; and per tool on a plugin server's
     execution entry (`"effects": {"tool": "send_as_person"}`), which Spade reads once ace's
     plugin import carries it (ace's `PluginExecution` is strict today, so that's the next
     change on ace's side). Unknown words in a declaration are dropped. On macOS a plugin's
     server is sandboxed, so only a declared send, payment, access change or credential changes
     what its calls do.
   - A tool with no declared effect (an unannotated MCP tool, a built-in missing from the table)
     asks the person on its first call. Their answer, allow or deny, is kept for that bot and
     tool, so the next call runs or is refused without asking.
   - Tool names and descriptions are never scanned for words. The name lists, `acts`,
     `words_say`, the mislabelled kind and `reads_credentials` are gone from routing; a grant is
     refused at creation by the tool's declared effect, not its name.
4. **The model reviewer becomes rare.** It sees:
   - the `publish` effect;
   - a `network` effect (a write outside the box) that no grant covers;
   - commands that run outside the sandbox (decision 5) and on platforms without one;
   - the taint rules ADR 0167 keeps: routines and notes set up after untrusted content, and a
     granted call under untrusted content.

   `judge.rs` stays as it is (one retry, plain sentences). `write_local` runs; where no sandbox
   holds the workspace, a file write is still reviewed as before. `change_access` goes to the
   person, like a payment. `credential` is refused before anything else.

5. **The person can run commands outside the sandbox.**
   - Each bot has a setting, `commands`: `sandboxed` (the default) or `outside`. The machine has
     one too, in Settings › Spade › Security, and a bot without its own inherits it. The machine
     defaults also hold the network policies, now editable: the Security page edits the machine's
     rules for commands and plugins, and a bot's own rule, when it has one, wins.
   - Per call: when a sandboxed command fails because of the sandbox (a Seatbelt denial, a host
     the proxy refused, an app it can't reach), the shell's answer says so and the bot may call
     `shell` again with `outside_sandbox: true`. That call is a request card: "Run this outside
     the sandbox?" with Allow once, Always for this bot and Deny. Allow once runs that call
     outside. Always for this bot runs it and sets the bot's `commands` to `outside`. Deny
     declines it.
   - A command outside the sandbox can't be contained, so it takes the review path that platforms
     without a sandbox use today: the credential word list, the shell classifier and the reviewer.
     The classifier stays only for this path.
   - Whether a call runs outside is decided at the gate and carried to the run by the call's key.
     A setting changed in between never moves an unreviewed call outside: without the mark it
     runs sandboxed.
   - Payments, sends and credentials keep their rules everywhere.
6. **Linux and Windows don't change in this pass.** They have no sandbox that holds both files
   and network, so their commands keep today's checks (the classifier and the reviewer). Finishing
   Linux (Landlock plus a seccomp filter that refuses UDP, raw and Unix sockets, so its network
   counts as contained) and Windows (AppContainer) are the next phases; each then gets decision 1.
7. **Stored events still fold.** `approval_requested` gains an optional `ask`
   (`undeclared` or `outside_sandbox`); events without it read as before. Old `call_reviewed`
   events, grants and settings read unchanged. A bot's stored network policy that equals the
   built-in default reads as inheriting the machine's, since every earlier build wrote one.

## Amendment 1: what the security reviews changed (2026-11-16)

Two security reviews of the first build found rules that a server's hints, a link or a repository's
settings could get around. These replace the matching parts of decisions 2 and 3.

- **Trusted declarations are a minimum.** Spade's table, a catalogue entry and a manifest the
  person accepted say the least a tool does. MCP hints can only raise it (a tool not marked
  read-only is at least `network`), never lower it. A catalogue entry's `every_tool` (formerly
  `writes`) covers every tool of the app, read-only or not, so a Stripe tool marked read-only
  still pays. A connector or plugin tool with no trusted declaration is undeclared whatever its
  hints say: the person decides once, and no grant covers it.
- **Unknown words are kept.** A declared word this build doesn't know is the effect `unknown`:
  the person decides each call, unless their Always allow covers it, and nothing grants it.
- **Driving a page or app is the person's.** An ace `browser_*`, `screen_*` or `sim_*` call ace
  doesn't mark read-only (a click, typing, a key, a submit) is the effect `drive`: until ace
  reports what a step did, it goes to the person unless their Always allow for that tool covers
  it, and nothing grants it. The purchase-button word list is gone. Snapshots, screenshots and
  reads stay `read`.
- **Person-only effects come first.** A secret is refused, and `pay`, `send_as_person`, `drive`,
  `change_access` and `unknown` go to the person, before anything about where the call runs is
  read. A sandboxed call whose checkpoint couldn't be taken is reviewed with that said, after
  those rules, not handed to the shell classifier.
- **Generic grants cover only declared tools.** A `tool` grant is refused at creation, and
  ignored at the gate, for a tool that declares nothing or could pay, send, drive, change access
  or read secrets.
- **A repository is known by its host.** Its identity is `host/owner/name` (`owner/name` means
  GitHub). Push and comment grants match the host too; one written as `owner/name` means GitHub.
  The request's line names where it goes ("It pushes to github.com/acme/app, branch main with
  your sign-in, so you decide.").
- **`git_push` reads the repository only through the sandbox.** Inside the bot's sandbox, a fixed
  script refuses a `.git` that is or holds a link or an alternates file, reads the remote's URL
  as stored (the repository's `insteadOf` and `pushInsteadOf` never apply) and writes a bundle of
  the branch into a fresh folder of Spade's that only that run may write. On the host, Spade
  fetches that bundle (a regular file nothing of the bot's can reach once the run ended) into a
  clean repository, adds the URL as a remote, and pushes only when the destination git reports
  after the person's own URL rewriting has the host and name the call named. Without a sandbox
  on the machine, `git_push` doesn't run; a push there is a reviewed shell command.

- **The outside card is answered for one call.** Its Always for this bot sets the bot's
  `commands` to `outside` and runs that call; it is never stored as an Always allow, so the same
  command later is reviewed like any command outside the sandbox. A request Spade asks for a
  reason of its own (`ask`) never stores an Always allow.
- **Allow once is bound to what it runs.** When the bot asks to run a command outside, the
  scripts it would run there are read and hashed into the request's `call_reviewed.bound`; if
  any differs when the allowed call is about to start, it isn't run (`Not run: A file it runs
changed after it was reviewed.`). A terminal command is also held to the folder and variables
  it was asked with.

- **An undeclared tool's answer is kept for that exact tool.** It is stored under the bot and the
  tool's identity: its server (a connection and its address, or a plugin, its accepted version
  and server), its own name and a hash of its schema, never the name it is offered under. A
  helper reads its bot's answer for the same tool. A name two sourced tools would be offered
  under (two servers, or names cut to a provider's limit) is offered for neither.

## Options considered

- **Better word lists.** Each fix moved a miss somewhere else, and two lists that disagree still
  give one input two answers.
- **Review every unsandboxed effect.** The reviewer is the slow, probabilistic part; for sends,
  payments and pushes the person's rule is exact and needs no model.
- **Let the bot run anything outside once the person turns the setting on, unreviewed.** Nothing
  outside the sandbox is contained, so the review platforms without a sandbox use is kept there.
- **Inject credentials at the proxy so commands can push.** Ending TLS at the proxy puts a Spade
  root in every sandbox (ADR 0167 decision 4). Typed tools keep the credential outside.

## Consequences

- On macOS a bot's commands never wait on a review, whatever they say. A command that needs
  more than the sandbox gives fails, and the bot can ask to run it outside.
- An MCP server that labels a sending tool read-only is believed. The catalogue can correct a
  known server, and an unlabelled tool asks the person once.
- A connector tool that only writes in the app (a Jira ticket) is reviewed, unless the person
  grants it or allows it always.
- Linux and Windows behave as before until their sandboxes are done.

## Tests

- `spade_core::effect`: tables for effects to routes, MCP annotations and declarations to
  effects, the built-in table, the sandbox-failure markers and the push and comment arguments.
- Through the API (`spade-server/tests/effects.rs`): a sandboxed shell call never reaches the
  reviewer; a typed send and a declared payment reach the person; a push a grant covers runs and
  one outside it goes to the person; an undeclared tool asks once and then remembers; the
  `outside` setting sends commands to review; a per-call request runs once after Allow; a machine
  default is inherited and a bot's own wins.
