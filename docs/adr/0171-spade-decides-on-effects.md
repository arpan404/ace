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
- **One table of tools and operations.** Where each operation of ace's driving tools acts is
  one table (`spade_core::effect::drive::table`, shown in spade/docs/autonomy.md): what it acts
  on in ace, the only fields the gate reads to find it, and whether ace must hold it there. A
  field an operation ignores (a `url` on a tab's `close`) never moves the place; a tool or
  operation missing from the table has none. Closing the whole browser (`browser_settings
close`) has no place either, so the person decides it.
- **Checked where input leaves, and a script is the person's.** The place is checked in each
  backend's transport, for every input command of every session it holds, inside the held
  command's own async context, so the person's input and other commands are never held to it.
  The check runs with the transport's command slot in hand, right before the write, and asks the
  page itself where it is first: a real Chromium reports a route a mousedown handler changed only
  after the press is acknowledged, so the browser's own report alone let a release through. A
  gesture's end whose press moved the page isn't sent. `browser_evaluate` runs any script the page
  allows, which no check on its calls confines: unrestricted, it always goes to the person; only
  ace's side-effect-free mode (`mode: read-only`) may be left to the reviewer.
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
  from it, though it is still read for where it is. Every step on a simulator or device goes to
  the person, whatever the operation and whatever a grant or an Always allow says: a device place
  is the person's alone by its kind, so an operation added later can't reach the reviewer. A step
  ace can't hold to its place asks too, even under an Always allow. An app on this computer whose window
  shows another device or computer (simulators, emulators, device mirrors, remote desktops and VM
  apps, and Xcode, Android Studio and QuickTime Player as a whole, since a window can't be told apart) is in the
  sensitive-app table, so input through the screen tools reaches the person the same way. A step a drive grant covers is still reviewed, told the person allowed the app, and the
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

## Amendment 4: the sandbox holds files, not authenticated remote effects (2026-11-18)

Decided by the owner (2026-11-18), after a security review of Full access found it and named the
same hole on the auto-review. Decision 1 and amendment 1 let a plugin MCP call whose server runs in
a working sandbox run with no classifier and no reviewer, and a tool there that declares nothing
run without the first-call ask: the OS boundary was to decide. But a plugin's server starts with
the environment its entry configures (an API token, say) and, under the default plugin network
policy, reaches public hosts. Holding its files doesn't hold what it does with that token: it can
send, post or pay as the person, and nothing looked.

- **An app's tool that can reach the network is decided as on the host, sandboxed or not.** A
  connector's or plugin's tool whose server isn't sealed (`Call::remote`, from `Tool::hints` and
  `Tool::sealed`) is routed as if it ran on the host, in every mode: one that declares nothing
  asks the person on its first call (their answer is kept, as before); one declared as writing
  (anything not read-only) goes to the reviewer, and Spade's classifier may raise it to the person
  as usual; one declared read-only runs. The person's Always allow and a `tool` grant still apply
  as on the host, and sends, payments, access changes and secrets keep their rules. Its arguments
  are checked for credential places like any call outside the sandbox.
- **Sealed is contained, held offline and without credentials of its own.** A plugin server is
  sealed when the sandbox holds it (`contained`), it launches under the sandbox's enforced
  offline policy, and its entry injects no environment of its own (where tokens go). `sealed`
  comes from the policy its launch applies (`Confined::offline`), never from a network setting
  or the absence of a proxy ticket: a run whose policy only lacks the proxy can still connect to
  a Unix socket in the workspace, and a socket there can forward to any network service. A
  plugin server whose network is off launches offline wherever the machine holds every boundary
  (`Runner::holds_offline`):
  - **Linux:** the launcher's plan is offline (`linux::plan_offline`): Landlock at ABI 3 or
    later, the seccomp filter refusing `socket` (so nothing is connected, bound or listened on,
    a workspace Unix socket and loopback included) and the supervisor refusing every address; it
    may still make connected `socketpair(AF_UNIX)` pairs, which reach nothing outside the run and
    which runtimes need (Python's asyncio, libuv). The launcher refuses to start an offline plan
    it can't apply, and descendants inherit the filter.
  - **macOS:** the normal Seatbelt profile with no network rule at all (`profile_offline`), and
    none of the Mach services that can reach the network on the run's behalf: no `trustd` or
    `trustd.agent` (certificate checks fetch issuers, OCSP and CRLs) and no `opendirectoryd`
    lookups (a Mac bound to a directory sends them to its LDAP or Active Directory servers), as a
    read-only run has none. It keeps only the system log (`com.apple.system.logger`) and
    `notifyd` (`com.apple.system.notification_center`), which stay on the machine and which the
    runtimes a server uses expect at start.
  - **Windows**, and any machine whose sandbox is partial: no offline launch, so no plugin
    server is sealed there.

  Spade's own program never runs with a plugin's environment. The Linux launcher, and on macOS
  the program in front of `sandbox-exec`, start outside the sandbox, and a plugin's entry can
  name what the system's loader runs before any of Spade's code (`LD_PRELOAD`,
  `DYLD_INSERT_LIBRARIES`). So such a launch (`Launch::seals_env`) starts that program with the
  run's variables renamed under a marker (`spade_sandbox::run_env`), which no loader reads, and
  they are restored only once the sandbox holds the run: on Linux on the command the launcher
  starts in its confined thread; on macOS by Spade's program run a second time, by `sandbox-exec`,
  inside Seatbelt (the profile lets it read that one file), so neither `sandbox-exec` nor the
  outer program ever runs with them. A name that can't be carried exactly (empty, holding `=`, or
  not UTF-8) stops the launch rather than being dropped. The release's `spade` is also
  signed with the hardened runtime and no `allow-dyld-environment-variables` entitlement, so
  dyld ignores `DYLD_*` for it anyway; the carrying doesn't rely on that.

  An offline run, like a read-only one, starts with its stdio alone: every descriptor the
  process starting it holds above stdio is marked close-on-exec first (`spade_sandbox::fds`), on
  Linux by the launcher, on macOS by Spade's own program run in front of `sandbox-exec`, so no
  socket or pipe Spade happened to leave open can carry a sealed server's calls out. The sweep
  fails closed: if the descriptors can't all be listed and marked, the run doesn't start. Where Spade's
  own program isn't known, macOS holds nothing offline.

  Only a sealed server's tools keep decision 1's rule: the sandbox decides, with no classifier
  and no reviewer. Connectors are never sealed: they are remote.

- **Outside the sealing guarantee: local channels.** A sealed server can still write in the
  bot's workspace, so a process outside it that can reach the network and reads that folder
  (polling a file, a FIFO) could relay for it. On macOS it can also post and read `notifyd`
  notifications (kept for the runtimes, above), whose names and states a cooperating local
  process can watch, so they can carry data too. Sealing doesn't cover that: it takes a
  cooperating process that isn't sealed and that the bot already controls (its own command, its
  terminal, a service, another plugin's server), and that process is decided by the gate on its
  own terms, its network calls by its sandbox and policy, and its outward effects by this ADR's
  rules. Sealing promises that the sealed server's own calls reach nothing outside the machine,
  not that nothing else on the machine does.
- **A classification that fails never widens where a call runs.** A call whose classification
  runs out of time or fails stays in the sandbox, and one that asked to run outside is refused:
  an approval to run outside is held to what Spade read the command would run, so it is created,
  and checked again right before the launch, only from a classification that succeeded; one that
  fails at the launch refuses the call.
- **An approval binds an exact, fully read decision; anything incomplete or changed refuses.**
  - What a command runs is read whole or marked incomplete. Incomplete is anything Spade
    couldn't read or resolve: a script past the read limit, outside its folder or unreadable; a
    command that doesn't parse (`$((...))` among it, since arithmetic can run commands); a folder
    `cd` goes to or a program it can't place; a command name built at run time (`$RUN`, `eval`);
    a script piped in, or written and then run; a sourced file it can't find; git or make
    configuration or options that run what it can't read; the reading's budget spent. A call
    that would run outside the sandbox with an incomplete reading is refused, never asked about,
    reviewed or run unreviewed. This replaces ADR 0163's rule that a script the reviewer can't be
    shown goes to the person, for every command that would run outside the sandbox.
  - A call allowed outside is read again twice before it starts, and doesn't start if any of it
    is incomplete or differs from what was allowed: once before it waits for its turn, and last
    by the run itself, after everything it waits on: for a terminal command under the terminal's
    lock, from the folder and with the variables it starts with, so an earlier command in the
    same terminal can't rewrite what it runs in between; for a one-shot command right before the
    spawn.
  - **Every stored verdict carries the launch it was given for**, and is reused only for that
    launch or a narrower one (contained only, then as the sandbox finds it, then outside): the
    person's answer (the approval request's `launch`), a reviewer's or a rule's verdict and the
    classifier's screening (`call_reviewed.launch`), an Always allow (the request it answered,
    whether scoped to one command or the whole tool), and a helper's mirror of its bot's. A
    verdict with no launch recorded (an older build's, even one asked to run outside) and a grant
    (which records none) hold for a contained launch only. A tool that launches no command (a
    connector, Spade's own) is a contained launch, so its grants and Always allows hold as
    before. So a call that would now run anywhere wider than its verdict (the bot's commands
    moved outside meanwhile, before or across a restart) doesn't run on it: it is reviewed or
    asked afresh. A word this build doesn't know reads as the narrowest.
  - Spade's classifier is read once per call, and that one reading routes the call and screens
    it, so switching the classifier off in between never lets an app's write skip both the
    screening and the reviewer; one routed counting on a screening that then can't happen goes to
    the reviewer.
- **Every launch keeps the gate's decision.** What the gate authorized (outside, only contained,
  or as the sandbox finds it) is carried to the launch of a one-shot command, a terminal command
  and an owned service (recorded with the service, so a kept one started again after a restart is
  held the same way); a run the gate let start only contained is refused wherever nothing holds
  it (no sandbox, or one that doesn't apply), never run plainly. Helpers and routines run through
  the same tools; plugin servers and hooks have no gate decision, and a server nothing holds is
  never sealed.
- **An app's tool can't write the bot's folder.** An unsealed connector's or plugin's tool
  declared `write_local` (with a read-only hint or not) is decided as a write outside the bot:
  reviewed after the person's own checks, never the local-write shortcut.
- **A person's "no" holds wherever the tool runs.** An undeclared tool the person declined for
  the bot is refused before any sandbox shortcut, so a plugin server that becomes sealed later
  doesn't bring a declined tool back.

- **Full access** ([ADR 0163](0163-spade-auto-review-only.md), amendment 2) applies the same
  rule, then its own: the classifier required for an app's write, the reviewer under untrusted
  content.
- **What changes for the person.** A plugin whose server holds a token or reaches the network now
  has its writes reviewed and its undeclared tools asked about once, as a connector's are. To
  have a plugin's tools run unreviewed in the sandbox, turn its network off for the bot and give
  it no token. A command outside the sandbox that Spade can't read whole is refused rather than
  asked about: the bot writes it plainly or runs it in the sandbox. An Always allow or an answer
  an older build stored, or one given while the bot's commands ran in the sandbox, asks once
  more before a command runs outside on it.

Tested in `spade_core::effect` (on the auto-review a sandboxed app tool that can reach the network
never runs unreviewed; a sealed plugin server's tools keep the sandbox's decision),
`spade_core::effect::full_access` (the same in Full access), and through the API in
`spade-server/tests/sandboxed_plugin_tools.rs` (a contained stdio server with an injected token
and its network on asks on an undeclared tool's first call and has its declared write reviewed,
in both modes; one sealed offline with no token runs, in both modes), and in the real Linux
sandbox in `spade-server/tests/sealed_plugin_offline.rs` (a sealed server can't reach a workspace
Unix socket that forwards to a TCP listener; a server with its network on reaches it and isn't
sealed). `spade-sandbox` tests the offline plan and profile (the offline profile looks up no
service that can reach the network), and, with real processes, that a descriptor left open in
the parent reaches neither an offline nor a read-only run (`inherited_fds.rs` on Linux,
`seatbelt.rs` on macOS, which also checks `trustd` fetches nothing for an offline run).
The approval binding is tested in `spade_core::review` (a stored verdict holds only for its
launch or a narrower one) and `spade_core::autonomy` (a reading that doesn't parse or resolve
what runs is incomplete), and through the API: a reviewer's allow stored for a contained launch,
or with none, is reviewed afresh after a restart once the command runs outside
(`effects.rs`); an approval stored without its launch, and an Always allow given for a contained
launch or with none, never let a command run outside (`effects.rs`); an outside request Spade
can't parse is refused and never asked about, and a script an earlier terminal command rewrites
after the first check doesn't start outside (`security.rs`). `classify-train`'s replay counts an
incomplete reading as refused, as the server does.

## Amendment 5: one way out of the sandbox (2026-11-18)

Decided after a further security review of Full access, which found four more ways a verdict and
the launch it let through could come apart: a redirect or an unknown program hid what a command
ran; a call run on an Always allow carried no binding; a service started where nothing held it
with nothing checked, and one an older build recorded started again as reviewed; a reviewer's
refusal stored before a restart ran once the bot was in Full access. Each was a separate path, so
the fix is one place every path goes through.

- **One check at the spawn.** Every shell run says whose it is (`workspace::shell::By`): a bot's
  command (one-shot, in its terminal, a service, a helper's or a routine's, which go through the
  same tools), Spade's own fixed script, or a plugin's hook. A bot's command that nothing holds
  (asked to run outside, a bot whose commands run outside, a machine with no sandbox, a sandbox
  that can't hold this run) starts only through `workspace::outside::admit`, called in
  `Shell::run_from` after everything the run awaits and right before the spawn: for a terminal
  command under the terminal's lock. It reads what the command runs again from the exact folder
  and environment it starts with (the bot's own command, not the wrapper the terminal adds),
  refuses a reading that is incomplete, refuses unless that reading is the one the verdict that
  let it run was given on, and refuses a launch wider than that verdict's limit (outside, or as
  found where nothing holds it). A run with no verdict's warrant never starts plainly.
- **Every verdict carries a warrant**: the launch it was given for and what the command ran then
  (`Warrant`). A run on the rules, an Always allow, a grant or Spade's classifier carries the
  reading it was decided on; a reviewer's verdict, fresh or stored, the binding it recorded; the
  person's answer the binding of the verdict that asked them (each ask stores one first); a
  service the launch and binding it started on, recorded with it (`service_started.launch`,
  `bound`). An empty binding is explicit, and holds only while the reading finds nothing of the
  command's own to run.
- **What runs is found apart from what it does.** The shell classifier finds every executable
  whatever the command's effect: a redirect outside the folder is a write outside, and the script
  the command runs is still read and shown. A bare program name is looked up on the `PATH` the
  command starts with: one of the system's folders is nothing more to read; a file in the bot's
  folder is a script it runs, read and shown; anywhere else (the person's toolchain) it is bound
  by where it is, its size and when it changed. A name `PATH` can't find, a `PATH` with an empty
  or relative entry, and a command that sets its own `PATH` make the reading incomplete. The tools
  that read configuration that can name a program for them to run (git, the Node package
  managers, cargo, ripgrep) have that configuration inspected in each folder they run in, and one
  that names a program makes the reading incomplete: outside the sandbox it is refused.
- **Services are read where they start.** A service's command is read from its own folder with
  the environment a service starts with, at the gate and at the spawn. One started again after a
  restart is held to the verdict that started it; one an older build recorded no launch for starts
  only contained, so where nothing holds it, it doesn't start.
- **A stored refusal stays one.** A verdict stored before a restart or a mode switch decides as it
  did: in Full access a stored refusal is still a refusal, and a stored question still asks;
  Spade's classifier's own verdicts stay apart from the reviewer's and the rules'.
- **Nothing else starts a process unlisted.** A test enumerates every process start in Spade's
  server and every shell run that isn't a bot's, each with why no verdict applies (Spade's own
  `cp` and `kill`, the typed outward tools' fixed `git` and `gh`, a plugin's server and hooks, and
  the shell itself, whose one spawn comes after `admit`); a new one fails it until it goes through
  the shell or is listed with its reason.
- **What changes for the person.** Outside the sandbox, a command that runs git in a repository
  whose configuration runs a program (hooks, an fsmonitor), a program not on its `PATH`, or one
  that sets its own `PATH` is refused rather than asked about. A kept service from an older build
  starts again only in the sandbox.

Tested in `spade_core::autonomy::shell` (a script is found and shown though its output goes
outside; a bare program is found on `PATH` apart from what it does; the tools that read
configuration are kept with the folder they run in), in `workspace::outside` (a start needs a
warrant as wide as its launch; a changed script, an empty binding with a script now, an
incomplete reading, git configuration that runs a program and a replaced toolchain program each
refuse; a program in the bot's folder is read as a script; and the enumeration of every process
start), in `confinement.rs` (every way a bot's command starts with nothing holding it refuses
without a warrant), `outside_launch.rs` (an outside request for git whose configuration runs a
program is refused, not asked; a script whose output goes outside is still bound; an Always
allowed command doesn't start once an earlier terminal command rewrote its script; a refusal
stored before a restart still refuses in Full access) and `services.rs` (a kept service starts
again only as it was allowed, and one an older build recorded only held).

## Amendment 6: a binding holds content, and Windows resolves only without doubt (2026-11-18)

A further review found the binding of amendment 5 weaker than it read.

- **A program is bound by its content.** A program a command runs from outside the system's
  protected folders is bound by its real (symlink-resolved) path and the SHA-256 of its content,
  read whole, at most 512 MiB; one larger, unreadable or gone makes the reading incomplete, so
  nothing is bound to a placeholder. Size and time stamps no longer stand for content: a rewrite
  of the same size with the time put back is caught.
- **Only the operating system's own programs are exempt**, by where their real path is, never by
  the `PATH` folder they were found through: macOS's `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin` and
  `/System`; Linux's `/usr/bin`, `/bin`, `/usr/sbin` and `/sbin` where the program and its folder
  are root's and writable by no one else; Windows' `%SystemRoot%\System32`. Everything else
  (Homebrew's, `/usr/local`, `/opt`, `/nix`, `/snap`, the person's toolchain, a link from any of
  them into a folder of the person's) is hashed. A program named by a system-looking path is
  looked up the same way.
- **Windows resolves a program only where cmd.exe can't choose otherwise.** cmd.exe looks in the
  folder the command starts in before `PATH`, and tries `PATHEXT`'s endings. Rather than emulate it
  wholly, Spade refuses (the reading is incomplete) when a file cmd.exe could take for the name is
  in that folder, when `PATHEXT` is empty or `PATH` has an empty or relative entry, or when nothing
  matches; otherwise it binds the first `PATH` folder's match in `PATHEXT`'s order.

Tested in `workspace::place` (cmd.exe's lookup refuses a same-named program in the starting
folder and follows `PATHEXT`'s order otherwise; only a real path in a protected folder is exempt)
and `workspace::outside` (a program rewritten to the same size with its time put back is refused;
one linked from a folder on `PATH` into a folder of the person's is bound by its target's
content; one too large to read whole is incomplete).

### Outside the sandbox: what the binding can't promise

Accepted with the owner (2026-11-18), in the order of ace's priorities: the control for a command
outside the sandbox is the decision, the person's or the reviewer's, on what it shows them; the
content binding is defence in depth behind it, and it has two limits this ADR doesn't close.

- **It isn't race-free.** A concurrent writer (another of the bot's own processes, one of its
  services, another app on the machine) can change a checked file between `admit` reading it and
  the moment the shell or interpreter opens it. What ships against that: the terminal's lock (no
  other command of the bot's runs in that terminal in between), the check at the spawn after
  every await, and the decision itself. Closing it fully would mean launching from immutable
  copies of everything a command runs; that is out of scope.
- **It covers bots' commands only.** A plugin's MCP server and its hooks are a separate trust
  decision, made when the person installs or enables the plugin (ADR 0151); they run contained
  wherever the machine has a sandbox, and on a machine without one they start plainly, with no
  verdict and no binding. The enumeration tests (`workspace::outside`) cover Spade's server
  crate only: they list every process start and every shell run that isn't a bot's in
  `spade-server/src`, not in the crates it uses (`spade-sandbox`'s launcher, `spade-connect`'s
  connectors) or in the daemon.

## Amendment 7: Permissions decide driving (2026-11-20)

Replaces amendment 3's routes for a driving step (its reviewer, its asks in sensitive places and
"Allow \<app\> for this bot"), and the Full access note's driving asks. Decided by the owner
(2026-11-20): once the person grants computer use, every computer-use step is approved, instead
of each one being reviewed and escalated.

- **A switch per family.** Each bot has Permissions (`spade_core::permission`): Computer use
  (`screen_*`), Browser (`browser_*`), Simulators and devices (`sim_*`), Apps (connectors' tools),
  Commands outside the sandbox, Network beyond listed sites, Send as you and Payments. A bot uses
  the machine's default unless it sets its own, and a worker is never freer than the bot above it.
  Commands and Network are the existing `commands` and network settings shown as switches; the
  rest are kept beside them in the bot's and the machine's security settings. No other permission
  store exists.
- **On runs, off refuses.** In both modes, after the organization's policy and the package's
  ceiling and before any Always allow, grant, review or request: a driving step whose switch is
  off is refused with one line saying where to turn it on. With it on, the step runs with no
  reviewer, no classifier, no second review and no card, reads and input alike, under untrusted
  content too. Apps, Send as you and Payments refuse their effect while off; on, the gate's usual
  route stands, so a send and a payment still ask each time.
- **The never-use list.** Under Computer use the person keeps a list of apps bots never use
  (password managers and money apps to start; the person adds and removes entries). The name a
  step gives and every app ace could open for it are read against it, and an app on it is
  refused. Nothing else stops a screen step once Computer use is on: mail, chat, settings and a
  browser driven through the screen run like any app.
- **Place binding stays.** The place is still resolved right before the gate and again right
  before the step, and a step that moved doesn't run. Every step a switch lets run is held to its
  place inside ace (`expect`); one that must be held and that Spade can't place (a tab loading or
  missing, a name matching several apps, a screen step with no app) or ace can't hold is refused,
  so the bot looks again. Under Browser and Simulators a step that sends no input and picks no
  tab (`table`'s `holds` false) runs without a place; a screen step never does, since the list
  needs its app.
- **Person-only to loosen, on every route.** Anything that lets a bot do more needs the person's
  stamp from ace's daemon (`x-ace-person`), as Full access does: turning a switch on, for a bot
  or the default, or following a default that is on; dropping an app from the never-use list;
  moving commands outside the sandbox (`…/security/commands`, a bot's or the machine's);
  widening a network policy, the commands' or the plugins' (a freer mode, a host added, a
  dropped default put back), or following a wider default (`DELETE …/network`); adding a grant
  of any kind; letting a bot use more connected apps (`…/connectors`); turning a package's effect
  on; raising autonomy. Tightening never needs it. Only Spade knows what holds now, so it decides
  whether a change loosens; the daemon stamps each such change, over the SHA-256 of the bytes it
  forwards, when the caller proved the person's standing, and otherwise forwards it unstamped. A
  refusal says "Confirm your identity to continue.", so a window offers Confirm it's you. On a
  shared bot the member whose `configure` stamp let the write through stands for the person
  (ADR 0206 §2.3); its Permissions switches take an owner or admin.
- **What is left.** A page or app the bot drives while untrusted content is in view can steer
  it; with the switch on, only the never-use list, the binding and the package's ceiling stand
  between that and the person's apps. Drive grants from earlier builds stay stored but decide
  nothing.

Tested in `spade_core::effect::permitted` (on runs with no review in both modes, off refuses,
the list refuses, unplaced and unheld steps refuse, a package ceiling and an organization still
hold), `spade_core::permission` and, through the API, in `spade-server/tests/effects.rs` (reads
and input with Computer use on run with no card and held to their app, Mail runs until it is on
the list, off refuses, a page that changed doesn't run, an ace that can't hold refuses, a step is
bound to its tab and address) and `spade-server/tests/permissions.rs` (turning a switch on
without the person's stamp is refused and works with it).

## Note: Full access (2026-11-18)

This ADR's routes are the auto-review's. [ADR 0163](0163-spade-auto-review-only.md) amendment 2
adds Full access, opt-in per bot: the same effects and places, the person-only effects first, then
no reviewer. Driving steps go by the bot's Permissions in both modes (amendment 7).

## Note: what Spade can't vouch for asks the person (2026-11-19)

[ADR 0163](0163-spade-auto-review-only.md) amendment 3 (the owner, 2026-11-19) changes what this
ADR's checks do when they can't vouch for a command outside the sandbox. Amendments 4 to 6
refused it; now the person decides, told why in one sentence, and the call waits for them:

- an incomplete reading at the gate (amendment 4's "refused, never asked about", amendment 5's
  configuration that runs a program, a program `PATH` can't find, a `PATH` the command sets,
  amendment 6's program too large to read) asks, whatever the route and in both modes;
- right before the launch, a reading that fails, isn't whole, or no longer matches the verdict's
  binding doesn't start the call: the person is asked again, on what it runs now, and only their
  new answer counts.

The binding is unchanged: Allow once is held to the verdict that asked, at the launch and at the
spawn. A person's Allow on an incomplete reading (`Warrant::incomplete`, theirs alone) lets the
spawn start a reading still incomplete if what could be read is unchanged; it can't bind what
couldn't be read, which the request says. A command Spade couldn't read at all when it was decided,
a race the spawn's own check catches, a declined tool and a secret are still refused; a driving
step whose place changed is still looked at again by the bot.

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
