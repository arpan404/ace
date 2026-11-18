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

## Amendment 2: Linux gets decision 1 (2026-11-17)

Replaces decision 6 for Linux. Linux's sandbox now holds files and network
([ADR 0167](0167-spade-security-boundaries.md) amendment 1: Landlock, plus a seccomp filter whose
supervisor makes every `connect`, `bind` and `listen` itself). Where Spade's probe finds Landlock
(ABI 1 or later), the filter and the proxy all working, Linux reports `contained` and decision 1
applies there as on macOS: a sandboxed command runs without the classifier or the reviewer, and
decision 5's outside path is the way out. Landlock refuses a file with `EACCES`, so "Permission
denied" joins the sandbox-failure markers. On a kernel without Landlock, or where the filter
can't run, Linux keeps the review path with a one-line reason in the sandbox status. Windows is
unchanged.

## Amendment 3: driving a page or app is reviewed, and asks where it matters (2026-11-17)

Replaces amendment 1's "Driving a page or app is the person's" and removes `drive` from its
"Person-only effects come first". Decided by the owner (2026-11-17: Spade asked them to approve
every click, keystroke and scroll of a computer-use session, so a session in an ordinary app was
a stream of requests). A request for each step taught the person to press Allow without reading,
which is worse than no request.

- **A step goes to the reviewer.** A `browser_*`, `screen_*` or `sim_*` call ace doesn't mark
  read-only is still `drive`, and still never runs unreviewed on a grant. Its review is told
  where it acts and that it acts there as the person, and to escalate a step that sends, pays,
  buys, changes access or enters a password, or that the person's request doesn't explain. With
  untrusted content in view the review is the strict one, as for other effects: it checks the
  step serves the person's request, not that content.
- **Where it acts, resolved right before the step.** The place is never inferred from earlier
  answers. Right before the gate decides, Spade asks ace, as the bot and with the call's
  `machine` and `browser`: for a page, `browser_tabs list`, and the step acts in its `tabId`,
  else in the tab ace marks `current`; for an app, `screen_apps` with the name given, and the
  step may act in every app whose name or id holds it (ace opens an app by part of its name).
  A step that opens an address (`url`) acts where it opens. A `sim_*` step that opens an app or
  an address acts there, and the device's own operations (start, stop, install, record,
  posture) act on the device.
- **Anything Spade can't place goes to the person.** A tab ace doesn't list, a tab still
  loading (a redirect in flight), a private tab, a page that isn't a web address, a name that
  matches several apps and none exactly, an answer ace couldn't give within 15 seconds, and
  input on a simulator or device (a tap, typing, a key, the clipboard: ace reports no app in a
  device's foreground) are asked, with a line that says which. No grant and no Always allow
  places them.
- **The place is checked again right before the step runs.** The gate keeps where it found the
  step acts, and the request the person answers keeps where they were told it acts (its
  `acts_in`). Right before the step starts, Spade asks ace again; if the page or app is no
  longer the same, the step doesn't run (`Not run: the page or app it acts in changed since
Spade checked it.`) and the bot looks again, so the gate decides on where it acts then. A
  click that navigates, Back, a redirect or another tab becoming current therefore never
  carries the place of the page before it.
- **And inside ace, right before each input.** A page's place is its tab and its whole address
  (scheme, host, port, path, query and fragment). Spade hands the step to ace with
  `expect {tabId, url}` (an app with `expect {app}`, its id), where ace's tool takes it. ace
  checks it when the step's turn comes in the tab's queue (an agent's input can wait there for
  the person) and again right before every input it sends; on `screen_*` the name must still
  find that app, and the helper sends every step of the batch, conditions included, to its id.
  A mismatch fails the step with `place_changed` and nothing more is done. The field is
  optional: ace's other callers leave it out. The reviewer alone may let a step that sends input
  to a tab or an app (`browser_act`, `_evaluate`, `_history`, `_measure`, `screen_act`,
  `_state`) run only where ace's tool takes it: against an older ace the step goes to the person,
  with a line saying an update lets Spade act there with only its review, and right before it
  runs a step the reviewer alone let run doesn't run if ace can't hold it after all.
- **A dialog's answer acts where the dialog is.** ace sends an answer to the tab that raised
  the dialog, whichever tab the call names, so Spade places it in that tab (the one whose
  `pending_dialog` has the call's `dialogId`); a dialog no tab shows asks.
- **A stored review holds only where it was given.** `call_reviewed` keeps where the step acted
  when it was reviewed (`acts_in`). A turn resumed after a restart reuses the verdict only if the
  step acts there now; otherwise, or with no place stored, the step is reviewed again.
- **The person decides in the places that matter.** A step goes to the person (`ask: drive`)
  when it acts in mail, messages or chat; a bank, wallet, payment, checkout or cart; a password
  manager or Keychain; the system's settings; a sign-in, account, security, settings, keys or
  members page; a social site; a web browser driven through the screen (Spade can't see the
  site); or a place Spade can't name. The list is `spade_core::effect::drive`: app words and
  names, hosts and their parent domains, parts of a host (`bank`, `pay`, `login`) and of a path
  (`/checkout`, `/settings`), of a `#/route` or of a route in the query (`?view=settings`; a search key's plain text, `?q=cheap flights`, doesn't count, but a value there that reads as a route, `?q=/settings` or `?s=checkout`, does). An address is read as a browser reads it (WHATWG
  parsing with IDNA mapping, so `%70aypal.com` and full-width letters are `paypal.com`, and
  escapes in a path are decoded). The apps are one table: each word comes with the full names it
  is found in, and a part of any of them (`cord` for Discord, `ail` for Mail) counts as that
  app, as does any app ace lists for the name that the table finds. The person's own dev server (a loopback address, `localhost`,
  `*.localhost`, `*.local`, `*.test`; `127.example.com` is a site like any other) is no one's
  account. Their Always allow for a driving tool still runs it elsewhere, but not
  here: in these places each step is theirs.
- **The reviewer can still ask.** A step it escalates, or one too long for it to read whole,
  goes to the person, as any reviewed call does.
- **Allow one app or site for a bot.** A request for a step in a place that isn't sensitive
  offers "Allow \<app\> for this bot". It answers always and makes a typed grant (ADR 0167
  decision 5) for the place the request kept: `drive_app {app}` for the app's id as ace lists
  it, or `drive_site {host}` for the site. An app grant never covers a site and a site grant
  never an app, whatever their words, and a device or simulator is never granted: a page a
  simulator opens (`sim_act open_url`) is the device's, so no site grant covers it or is made
  from it, though it is still read for where it is. A step a drive grant covers is still reviewed, told the person allowed the app, and the
  review escalates only a send, a payment, a purchase, an access change or a password, so the
  rest of the session there runs without asking. A drive grant is refused at creation for a
  sensitive place, and one stored by hand covers nothing. The request's always never stores an
  Always allow for the tool. A `tool` grant still never covers a driving tool: it would cover
  every page.
- **ace's own list is ace's.** An app under ace's Apps agents can't use, and the apps ace always
  refuses (terminals, Keychain Access, Passwords, sign-in prompts), are refused by ace before a
  step reaches them, whatever Spade decided, so Spade doesn't keep a copy.
- **Stored events still fold.** `approval_requested` gains `ask: drive`, an optional `app` (the
  name the card offers to allow) and an optional `acts_in` (the place); a client that doesn't
  know them shows the usual request, with no always.
- **What is left.** ace checks the place before each input it sends, not inside the browser's
  own dispatch of it, so a navigation that starts in the same instant can still take an input.
  A step the person allows, or allows always, against an ace whose tools don't take `expect`
  runs with Spade's own check right before handing it over as the last one. Device input asks each step until ace reports which app is in a
  device's foreground.

Tested in `spade_core::effect` (each place to its route, a granted app, a sensitive one, an
unplaced step and a tainted one), `spade_core::effect::drive` (the current tab against another
tab, Back and a redirect, device input, parts of app names, addresses as a browser reads them,
what may be granted), `spade_core::grant` (an app and a site with the same words) and, through
the API, in `spade-server/tests/effects.rs` (a click in TextEdit is reviewed, typing in Mail
asks, allowing TextEdit stops the asking, and a step whose page changed after its review doesn't
run).

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
