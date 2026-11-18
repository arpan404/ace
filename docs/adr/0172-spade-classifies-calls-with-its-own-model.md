# 0172: Spade classifies calls with its own small model

Status: accepted. Date: 2026-11-16. Decided by: the owner (2026-11-16: a fast, lightweight,
reliable classifier of Spade's own, in front of the model reviewer). Builds on
[ADR 0171](0171-spade-decides-on-effects.md) and its amendment 1, and keeps
[ADR 0167](0167-spade-security-boundaries.md) and [ADR 0163](0163-spade-auto-review-only.md)
as they are. The contract is in [spade/docs/autonomy.md](../../spade/docs/autonomy.md) and the
model's measures are in `spade/crates/spade-classify/model/REPORT.md`.

## Context

After ADR 0171 most calls are decided by what they declare or by the sandbox. What's left goes to
the reviewer, an LLM call that can be slow, cut off or wrong: commands that run outside the
sandbox (a bot set to run outside it, a call the person allowed outside, and Linux and Windows,
which have no full sandbox yet), a connector or plugin tool's write that no grant covers, and the
`publish` effect. Most of those calls are ordinary. `cargo test` run outside the sandbox waits on
the same model call as a send hidden in an AppleScript here-document.

A small model of Spade's own can answer the clear cases in microseconds, on the machine, the same
way every time, and leave the rest to the reviewer as today.

## Decision

1. **The rules.**
   - The model is never the security boundary and never lowers a deterministic decision. The
     sandbox, declared effects, the credential refusal and the person-only effects (`pay`,
     `send_as_person`, `change_access`, `credential`, `drive`, `unknown`) are decided before it,
     exactly as in ADR 0171. It only sees calls the rules already sent to the reviewer.
   - It can do two things, each only above a calibrated threshold:
     - **raise** a call to the person when it reads a person-only effect;
     - **settle** a call as clearly low-risk (`read`, or `write_local` in the bot's folders).
       Everything else **abstains** and goes to the reviewer as today.
   - The thresholds are set for a near-zero rate of risky calls settled as low-risk on held-out
     data that includes obfuscated and adversarial cases. The measured precision and recall are
     recorded below and in `REPORT.md`.
   - It is deterministic (the same input gives the same output, bit for bit) and fully local:
     no network, and no model or provider call, to run it or to build it.
2. **Where it may settle.** Only a shell command that runs with no sandbox, when the shell
   classifier found nothing in it, it runs no file the reviewer would be shown (a script, a
   makefile, a package script), nothing untrusted is in view, it sets up no standing work and the
   rules named no concern (`spade_classify::Reviewing::may_settle`). Every other call under review
   (a connector or plugin tool, `publish`, a write no grant covers, anything tainted) can only be
   raised or left to the reviewer. Spade's and ace's own tools aren't shown to it: they declare
   what they do. An undeclared tool's first call stays the person's (ADR 0171).
3. **What it never settles, whatever it reads.** A call that points outside the bot's folders (the
   home folder, an absolute path, `..` climbing out, a variable, another machine's path, a URL
   that isn't a web page); one that hides what it runs (decoded or built text run as code,
   `eval`, a program from a variable, an alias or a function defined in the command, escapes,
   look-alike or invisible letters, text the parser can't read); and one with a program,
   subcommand or flag never seen in a low-risk training command (`npm install` is known;
   `npm install -g` isn't); and one where any structural input was past a feature bound (the text
   over the character limit, more commands or words than the window reads), since what was dropped
   could be an outside path or an unknown program. These are checks in code, not learned, and the
   outside-path and known-part checks run over the whole of what is read, independent of the
   bounded feature hashing (every option character is a key, every word and command within the
   window is scanned).
4. **The crate.** `spade-classify` is pure Rust with no ML runtime:
   - **Features.** For shell, Spade's own shell parser (`spade_core::autonomy::shell::read`): each
     simple command's program, subcommands, flags, argument shapes (URLs and their hosts, paths
     placed against the bot's folder, e-mail addresses, amounts), redirects, pipes, here-document
     text and the words of inline code, plus the words as written (the parser takes `sudo` or
     `env` off) and markers of hiding. For tool calls, the name split into words, the MCP hints and
     trusted declaration, argument keys and types, value shapes and short values' words; a
     `command` argument is read as a shell command. Both are hashed into 131,072 rows, with
     character 3- and 4-grams of the text, after look-alike letters are folded and invisible
     characters dropped, so an obfuscated word still lands near the plain one.
   - **Model.** A linear softmax over nine effects (`unknown` is a declaration's word, never a
     reading), int8 with a scale per class, plus a 128 KiB Bloom filter of the programs,
     subcommands and flags seen in low-risk training commands. The file is `include_bytes!`'d:
     1.31 MB. A file that doesn't read leaves the classifier abstaining on everything.
   - **Output.** A calibrated probability per effect (temperature scaling), and the decision.
5. **Training.** `spade/tools/classify-train`, in Rust, with a fixed seed (172), in about a second:
   - **Data.** Spade's own test commands (the shell classifier, effect and autonomy tests),
     labelled by Spade's own rules; and a template generator for dev commands, package managers,
     git, curl and wget, interpreters, AppleScript and JavaScript for Automation, sends, payments,
     publishes, access changes and credential reads, with obfuscations (quoting, backslashes,
     variables, spacing, base64 with `eval` or a pipe into a shell, `sh -c`, here-documents and
     here-strings, aliases, functions, wrappers, look-alike letters, zero-width and full-width
     letters, `printf` hex, `rev`, `python -c os.system`), and tool calls whose names hide what
     their arguments show. Labels are the rules' or the template's intent. No public corpus is
     used; `model/DATA-LICENSES.md` records that.
   - **Splits.** Each family's templates are split about 60/20/20 between training, validation and
     test, and filled from separate halves of every value list, so no form or value crosses sets.
     Six obfuscations are never in training at all.
   - **Thresholds.** From validation only. Raise at the lowest probability with at least 98%
     precision on validation, never below 0.6. Settle at the lowest probability above every risky
     validation call, never below a fixed floor of 0.95. Validation alone would allow 0.229, so
     the floor is what binds; validation settles no risky call at either. The floor was set
     earlier, after a first run with 0.90 let two of that run's test commands through (`ssh …
uptime` and `defaults write`). That looked at test data, so the first test sets are no
     longer a clean measure; the fresh sets below are.
   - **Fresh held-out sets.** `classify-train/src/fresh.rs` holds shell variants for every
     family, tool names (misleading ones included) and values written after that look, none in
     any earlier set (a test checks it), generated from their own seed (2026) with every trick.
     Nothing is chosen or tuned on them.
   - **Shipped model.** Measured with the protocol above, then retrained on every earlier template
     with the same temperature and thresholds. The six unseen obfuscations, the misleading tool
     names and the fresh sets stay out of its training.
6. **Wiring.** In `spade-server`, on the gate's review route: if the classifier is on and no
   verdict is stored for the call, it decides. Low-risk runs; a person-only reading raises a
   request with that effect's plain line ("It sends something in your name, so you decide.");
   an abstention goes to the reviewer. A settled or raised call stores `call_reviewed` with the
   model's name (`spade-classify/<hash>`) and no cost, so a restart reaches the same answer and
   the activity log shows it. Each decision is logged on the machine in
   `<data>/classifier/decisions.jsonl` (rolling at 1 MiB): the call's id and tool name, the class,
   confidence and decision, never its arguments, so a later retraining can be measured against
   the reviewer's verdicts.
7. **The setting.** `PUT /v1/oversight {"classifier": false}` turns it off for the machine;
   everything the gate holds then goes to the reviewer as before. It is on by default.

## Measures

The clean measure is the fresh sets (seed 2026), on the shipped model (`REPORT.md` has every set,
both models and each obfuscation):

| Fresh set                                         | Risky calls settled as low-risk | Low-risk precision | Low-risk recall | Raise precision | Raise recall |
| ------------------------------------------------- | ------------------------------- | ------------------ | --------------- | --------------- | ------------ |
| held-out forms, clean                             | 0 of 1,920                      | 1.000              | 0.118           | 0.984           | 0.942        |
| adversarial (every trick, misleading tool names)  | 0 of 5,139                      | 1.000              | 0.032           | 0.973           | 0.843        |
| held-out forms, clean, as wired (the rules first) | 0 of 1,920                      | 1.000              | 0.107           | 0.984           | 0.942        |
| adversarial, as wired                             | 0 of 5,139                      | 1.000              | 0.029           | 0.973           | 0.843        |

The model measured before retraining (training templates only) also settles none of the fresh
risky calls (0 of 1,920 clean, 0 of 5,139 adversarial), with low-risk recall 0.060 and raise
precision 0.967 and recall 0.876 on the clean set.

Low-risk recall on forms it never saw is low, by design: a program, subcommand or flag never seen
in a low-risk training command abstains, and the reviewer decides as before. On the forms it was
trained on, with values it never saw, it settles 0.714 of low-risk commands (0.663 as wired) and
no risky one; everyday commands like `git status`, `cargo test` and `cat README.md` settle, and
`ls`, `pwd` and a plain `curl` GET abstain.

The first test sets, no longer clean, settle no risky call either (0 of 3,020 held-out forms, 0
of 8,062 adversarial). With seeds 2 and 3 nothing risky is settled in any set. With seed 1 the
model alone settles 2 of 3,015 in its test set, both a connector tool running `cat .env`. Tool
calls are never settled as wired, so the count there is 0; it is the reason decision 2 keeps
tool calls to raising.

On this Mac one classification (features and inference) takes 2.7 µs at p50 and 62 µs at p99
(`cargo bench -p spade-classify`).

Building the data showed a gap in the shell classifier, fixed with this ADR: a command after a
shell keyword was not read (`{ git push; }`, `if git push; then …`, `while …; do xdotool …`,
`! git push`), nor the body of a function defined in the command, nor an alias defined in it
(`alias q='xdotool'; q type …`). Keywords are now taken off before reading, so function bodies
are read where they are written, and an alias is read through to its text. An alias whose text
can't be read is unclear. An empty alias and one whose value ends in a space no longer drop the
words that follow (a later review found the credential reader could vanish), and `command`,
`builtin`, `env` and `exec` were already unwrapped. A later review also found the classifier could
settle a call whose outside path sat past a feature bound; those bounds now force an abstention and
the eligibility checks read the whole of what is parsed.

## Options considered

- **A bigger model (an MLP or an embedding bag).** A linear model over engineered features is
  enough to tell these classes apart, is easy to inspect, and keeps the file at 1.3 MB with
  inference in microseconds. The checks in decision 3, not model size, are what keep settled
  calls safe.
- **An ML runtime (ONNX and the like).** A dependency and a native library for a sparse dot
  product.
- **Labels from an LLM, or public command corpora.** Labelling with a model spends the person's
  quota and was ruled out; public corpora have unclear licences and no labels for these effects.
- **Letting the model settle tool calls and `publish`.** A connector's write or a publish is
  declared as more than low-risk; settling it would lower a declaration.

## Consequences

- Plain commands outside the sandbox (on Linux and Windows today, and for bots set to run
  outside) usually run without waiting on the reviewer, and a send or a payment the reviewer
  would have seen goes to the person directly.
- Everything else is reviewed exactly as before. Turning the setting off restores today's path.
- A wrongly raised call costs the person a tap; a call wrongly settled is what the thresholds and
  the checks are tuned against.
- Retraining is a reviewed change: run `classify-train`, check `REPORT.md`, commit the weights.

## Tests

- `spade-classify`: determinism, a coarse latency bound (median under 1 ms even unoptimised),
  an adversarial table of obfuscated sends and credential reads that must never be low-risk,
  plain person-only calls raised, plain reads and builds settled, outside, hidden and unknown
  commands never settled, raising never settling, the settle precondition, and damaged model
  files refused. Plus a bench for p50 and p99.
- `classify-train`: the value halves never overlap, the fresh pool shares nothing with the
  earlier ones, the fixture reader and labels, base64.
- `spade_core::autonomy::shell`: tables for aliases read through (including empty and
  trailing-space aliases and mutual redefinitions), function bodies read, and commands after
  shell keywords.
- `spade-classify`: input past a feature bound is never settled, and random unicode and very long
  input on both the shell and tool paths never panic on a slice.
- Through the API (`spade-server/tests/classifier.rs`): a plain command with no sandbox runs
  without the reviewer and is logged without its arguments; a tool read as a send goes to the
  person; an abstention goes to the reviewer; turned off, the reviewer decides as before; a
  person-only effect the rules decide never reaches the classifier.

## Amendment 1 (2026-11-17): measured on real work, and settling reads under untrusted content

Decided by: the owner (2026-11-17: the classifier "is completely broken" in practice; make it
useful and provably safe, with numbers that hold up). Changes decisions 2, 3 and 5; the rules in
decision 1 are unchanged.

### What was measured

The template sets above say little about real use, so the classifier is now measured on sets
that aren't its templates, labelled by hand or by a reference labeller written for measuring
(`classify-train/src/label.rs`: explicit tables, Spade's own rules and tldr's descriptions; it
never sees the model). A call the labeller can't name counts as risky, so a settled one counts
as a false low-risk; those were then read by hand.

- **A hand-labelled hard set** of 213 commands written for it (`hard.rs`): everyday commands that
  look busy and risky ones that look plain.
- **Hand-labelled connector calls** (`connectors.rs`): 65 calls in the shapes the public GitHub,
  Slack, Gmail, Linear, filesystem, Google Calendar and Drive, Notion and Stripe MCP servers offer.
- **tldr-pages** (CC BY 4.0, pinned commit; `DATA-LICENSES.md`): 41,757 filled examples; one page
  in five is held out of training. NL2Bash is GPL-3.0 and stays out.
- **Real coding-agent sessions** on the owner's machine: 6,708 calls (5,564 shell commands) from
  56 Claude, Codex and OpenCode threads, read from a read-only copy of `events.sqlite`
  (`real-sessions.sh`; no daemon is started). Measured only: never trained on, never committed,
  aggregates only.
- **End to end**: those sessions replayed through the whole gate as a Spade bot with no sandbox
  would meet them (`replay.rs`): `effect::route` with the shell classifier's reading first, then
  the classifier on what is sent to review, with untrusted content following Spade's own rule (a
  command's output and a file Spade didn't write are untrusted). These sessions mostly work
  outside the folder they were started in (sibling worktrees 42% of commands, `/tmp` 32%, the home
  folder 16%), which the classifier never settles, so the replay is also given with each thread
  placed in the folder it `cd`s into most: the same calls as a bot whose own folder that is.

`cargo run -p classify-train -- --tldr DIR --real DIR` reruns all of it; `classify-train
measure --weights FILE` scores any model file.

### Why it almost always abstained

Measured on `main`'s model and wiring, with the same labeller:

1. **Untrusted content in view.** It may settle only with nothing untrusted in view, and a
   command's own output is untrusted, so after a conversation's first command it could settle
   nothing. 5,514 of the 5,564 real commands ran with untrusted content in view. Of the 5,259 the
   rules sent to review, 65.3% were barred for that alone, 34.0% had a rule finding (here-documents
   and unreadable text 1,329, writes outside 293, network 72), and 0.7% were open to it.
2. **A part never seen as low-risk.** This check stopped 90% of tldr's low-risk commands and 45% of
   the hard set's: the training templates knew few flags, and a digit after an option letter
   (`-A5`, `-j8`) was read as an option of its own.
3. **Outside the folder.** It stopped 91% of real low-risk commands. Mostly it was right: the work
   happened elsewhere. But the gate passed no folder, so an absolute path into the bot's own
   folder also read as outside, and `$?` read as a variable path.
4. **Template coverage.** Ordinary agent shapes (chained reads, `2>&1 | tail`, reading code about
   payments or tokens) read as risky: a search for `send_email` carried the weight of a send. The
   same gap made it raise file edits done through `python - <<'EOF'` to the person: 56 of the 57
   real calls it raised weren't person-only.
5. **Not the 0.95 floor.** On the calibration data (the validation split and tldr's validation
   pages, unnamed calls counted unsafe) alone the threshold would be 0.895, so the floor stays and
   binds with a margin of 0.055.
6. **Not mainly the model's capacity.** A small MLP (one hidden layer of 16 ReLU units, the same
   data, calibration and checks) settles up to 2 points more of the low-risk calls in the untouched
   sets at no false low-risk, at about 1.8× the work and 2 MB of weights, and with 12 units it once
   settled a risky held-out command. What binds now is which commands have a hard form
   (amendment 3), not capacity. The linear model stays; `REPORT.md` reruns the comparison.

### Decision

1. **Reads under untrusted content.** A plain command (decision 2's conditions, except taint) may
   be settled while untrusted content is in view only as a read: P(read or write_local) over the
   low-risk threshold, P(read) alone over a read threshold of its own (`Header::read`, 0.801: above
   every calibration call that isn't a read and could be settled there, by 0.02, never below 0.8),
   and nothing in it that can reach another machine (`Prediction::network`: a program that can,
   or a URL, host or address argument). A read in the bot's folder that reaches nothing neither
   sends nor changes anything, and what it shows joins content that is already untrusted. Writes,
   builds and anything that may reach the network wait for the reviewer as before.
2. **The folder.** The gate passes the bot's folder to the classifier (`Classed::workspace`, set
   when the command starts inside it), and a command it can't place against the folder (a service
   command with its own `cwd`, a start folder outside the workspace) is never settled.
3. **More things it never settles**, in code (decision 3): an option that runs another program
   (`rg --pre`, `tar --to-command`/`-I`, `rsync -e`, `find -exec`, `fd -x`, `git -c`, `sort
--compress-program`), and a wrapper that runs a command with the person's secrets in its
   environment (`doppler run`, `op run`, `aws-vault exec`, `infisical`, `sops exec-env`…), which
   the parser takes off. The next word after a subcommand whose meaning it changes (`git remote`,
   `git stash`, `git bisect`, `jj git`, `brew services`, `npm config`…) is a key part; a digit after
   an option letter is its value; `$?`, `$#` and `$$` aren't paths.
4. **Raising.** The person is asked when the person-only effects together pass the threshold
   (0.60, the lowest with 98% precision on the calibration data); the request names the likeliest
   one.
5. **Training data.** Besides the templates: tldr-pages' commands labelled by the reference
   labeller (one it can't name is never trained on), and new families in the shapes agents write,
   including desktop input on Linux and macOS and tokens in headers. Thresholds come from the
   calibration calls whose effect the labels name (amendment 2).
6. **The same bits everywhere.** `exp` (inference and training) and `ln` (calibration) are plain
   arithmetic, so the shipped file is reproducible on any machine, not only the one it was trained
   on (`main`'s file, trained on a Mac, differs from a Linux run from the same seed).
7. **Connector tools stay raise-only.** A read-only connector call with a trusted read
   declaration already runs on the rules; any connector call that reaches the classifier is
   declared as more than a read, and settling it would lower a declaration. So no change.

### Measures, before and after

Every "after" number is for the exact shipped weights (`spade-classify/c886542e`), calibrated and
measured as amendments 2 and 3 set out, on sets their fit never touched, with the gate's checks as
it runs them: a command settles only in its hard form (amendment 3). `main` is
`spade-classify/99f56e23` as wired on `main`, measured with the same labeller on the same sets.

| Set                                                           | Low-risk recall   | False low-risk                        | Person precision  | Person recall     |
| ------------------------------------------------------------- | ----------------- | ------------------------------------- | ----------------- | ----------------- |
| Fresh, clean                                                  | 0.118 → 0.104     | 0 of 1,920 → **0 of 1,920**           | 0.983 → 0.976     | 0.942 → 0.919     |
| Fresh, adversarial                                            | 0.032 → 0.033     | 0 of 5,139 → **0 of 5,139**           | 0.973 → 0.963     | 0.842 → **0.852** |
| Held-out tricks and tools (main: its own 4,849; after: 5,871) | 0.070 → 0.002     | 0 of 3,312 → **0 of 3,751**           | 1.000 → 1.000     | 0.895 → **0.955** |
| Hand-labelled hard set                                        | 0.449 → 0.339     | 0 of 95 → **0 of 95**                 | 0.979 → **1.000** | 0.920 → **0.960** |
| tldr-pages, held-out pages                                    | 0.053 → 0.037     | 3 → **0** of 7,000 (risky or unnamed) | 0.201 → **0.283** | 0.189 → **0.500** |
| Real sessions, distinct commands, model alone                 | 0.024 → **0.037** | 1 → **0** of 2,310 (risky or unnamed) | 0.136 → **0.857** | 0.070 → **0.094** |
| Hand-labelled connector calls (raise only)                    | –                 | –                                     | 0.900 → 0.889     | 0.857 → 0.762     |

Low-risk recall on the template and tldr sets is lower than `main`'s: `main` settled builds,
installs, `git status`, `git diff` and plain `curl`, which can run programs named in configuration
the command never shows, and those now stay with the reviewer. Every measure counts a call the
labeller can't name as risky, and none of those is settled any more either.

End to end, real sessions (shares of 6,708 calls):

| Replay                                                 | Run on the classifier | Raised to the person (person-only of all it raised) | Reviewer  | Decided without the reviewer | False low-risk |
| ------------------------------------------------------ | --------------------- | --------------------------------------------------- | --------- | ---------------------------- | -------------- |
| As recorded, `main`                                    | 0.1%                  | 0.8% (1 of 57)                                      | 78.1%     | 21.9%                        | 0              |
| As recorded, this build                                | **2.1%**              | 0.2% (9 of 11)                                      | **76.8%** | **23.2%**                    | **0**          |
| Placed in the folder each thread worked in, `main`     | 0.1%                  | 0.8% (1 of 57)                                      | 79.1%     | 20.9%                        | 0              |
| Placed in the folder each thread worked in, this build | **23.7%**             | 0.2% (10 of 12)                                     | **56.1%** | **43.9%**                    | **0**          |

A false low-risk here is a settled call the labeller doesn't name as low-risk, or, with untrusted
content in view, one it doesn't name as a read. Run by the rules (12.0%), asked by the rules (7.8%,
6.8% placed) and refused (1.1%) are the same in every row. Of the 55 person-only real calls the
rules sent to review, the classifier raises 9 or 10 (before: 1); the other calls it raised are ones
the labeller can't name.

One classification on this Linux machine (`cargo bench -p spade-classify`, features, inference and
the hard-form check): p50 2.8 µs → 5.2 µs, p99 65 µs → 125 µs, worst 643 µs → 160 µs. The
configuration inspection is a few small file reads on the gate's blocking thread. The file is
1,310,824 bytes.

### What is still weak

- Builds, tests, package installs, `git status`, `git diff` and `git show` never settle: no
  override covers what they can run (diff and filter drivers by name, package and cargo config).
- Reading against writing: `git log` (P(read) 0.50) is under the read threshold, so with untrusted
  content in view it still goes to the reviewer; plain `ls` (0.86) and `pwd` (0.95) abstain.
- Most real work happened outside the folder each thread was started in, and the classifier never
  settles that. A third of what the rules send to review has a rule finding, mostly here-documents
  and text the shell parser can't read; only the rules can open that up.
- Person recall on real calls is 9 or 10 of 55; raising on the connector set is a little below
  `main`'s.
- The labeller can't name 67% of tldr-pages' held-out pages and 29% of real commands; every
  measure counts those as risky.

### Follow-ups outside the classifier

- Spade's shell rules (`spade-core`) don't treat Linux input tools (`wtype`, `ydotool`, `dotool`,
  `wlrctl`) as driving apps, and they take secrets-injecting wrappers (`doppler run`, `op run`,
  `aws-vault exec`) off without a credential finding. The classifier now holds both back, but
  these belong in the rules.
- PR #2265 (computer-use routing, not merged) and this change meet in a few places, all
  mechanical: both add a field next to each other in `engine/classify.rs` (its `acts_in` on the
  stored verdict) and in the tests' `FakeTool` (its `answers`, this one's `unplaced`), and both
  edit the classifier's paragraphs here and in `spade/docs/autonomy.md`. This change doesn't touch
  `effect.rs` or `calls.rs`; code that builds `autonomy::Classed` by hand needs the new
  `workspace` field (`None` keeps the classifier from settling).

## Amendment 2 (2026-11-18): configuration that runs programs, and calibrating the shipped weights

Decided by: the owner, after review of amendment 1. Changes decisions 3 and 5.

### Configuration that runs programs

`git status` runs the program a repository's `core.fsmonitor` names; git can also run a pager,
diff and filter drivers, credential and gpg programs, aliases that start a shell, and hooks, all
from configuration the command never names, and the rules read configuration only for the git
operations that run hooks. A "read" could run code. The Node package managers (`.npmrc`'s
`node-options` and `script-shell`, a pnpmfile, `yarnPath`, `bunfig.toml`'s `preload`, `.env` for
bun), cargo (`.cargo/config.toml` runners and wrappers, a toolchain file's `path`) and ripgrep (a
config file's `--pre`) do the same.

1. **The gate inspects it.** For a command with no sandbox the shell tool inspects, from the folder
   the command starts in and through the environment it will run with, the configuration of each
   of those tools (`spade_classify::inspect`, pure, over the files and variables the gate brings;
   `Classed::config_clean`): for git, the repository's config, its worktree's (`commondir`,
   `config.worktree`), every file either includes (`include`, `includeIf`), the home's config
   (Spade runs commands with `HOME` set to the bot's folder, so `~/.gitconfig` is a file the bot
   can write), the hooks folder and `GIT_*` variables, a terminal's carried ones included; for
   the others, their files in the folders from the start folder up to the bot's folder, and their
   variables. A file that can't be read counts as running something. Machine-wide configuration
   and folders above the bot's folder are the person's and aren't read.
2. **A command that runs git, a Node package manager, cargo or ripgrep is settled only when that
   tool's configuration names no program** (`rg --no-config` needs none), and since amendment 3
   only in its hard form; the inspection is then one more reason to abstain. Otherwise it goes to
   the reviewer. Never settled at all: such a tool run after a `cd` to a folder other than the bot's
   own, or pointed at other configuration (`git -C`, `--git-dir`, `cargo --config`, `npm
--node-options`, `--prefix`); a command that sets a variable that makes a program load code or
   read other configuration (`PATH`, `PYTHONPATH`, `NODE_OPTIONS`, `LD_*`, `GIT_*`, `CARGO_*`,
   `LESSOPEN`, `PAGER`, `RIPGREP_CONFIG_PATH`…); one run through a project environment (`direnv`,
   `nix-shell`, `devbox`, `mise exec`); and one carrying a credential (a URL with a password in
   it, or a string shaped like an issued token or key). Make already runs files the reviewer is
   shown, and interpreters (Python, Node) can reach the network, so neither settles with untrusted
   content in view; builds and tests run the project's own code by design (decision 1) and settle
   only with nothing untrusted in view.
3. On the real sessions no command was held back by its folder's configuration; the regression
   test `a_read_in_a_repository_whose_config_runs_a_program_goes_to_the_reviewer`
   (`spade-server/tests/classifier_git.rs`) runs real git on a repository whose fsmonitor would
   leave a marker, and checks the reviewer decides and the marker never appears.

### Calibrating the weights that ship

Amendment 1 refitted the shipped weights on every template after choosing the temperature and
thresholds on a model fitted without validation, so its calibration described another model.
Now there is one model, and every number describes it:

- **Fit** on the training split, the first test sets' templates and fixtures, and tldr-pages'
  training pages.
- **Calibrate** (temperature, low-risk, read and person thresholds) on the validation split and
  tldr-pages' validation pages, reserved from the fit.
- **Measure** on what neither touched: the fresh pool, the tricks and misleading tools held out of
  every fit, tldr-pages' held-out pages, the hand-labelled sets, real sessions and the replay.

Calibrating the shipped weights this way showed a gap the refit had hidden: a clone URL carrying a
token (`https://user:ghp_…@github.com/…`) read as a plain clone. Such a command is now never
settled (above). Fresh clean low-risk recall is 0.316, not the 0.477 the refit reported; every
figure in amendment 1 is now the shipped weights'.

## Amendment 3 (2026-11-18): settled commands run in a hard form

Decided by: the owner, after the second review of amendment 2. Changes amendment 2's decision.

### Context

Amendment 2 inspected configuration when the gate decided and kept only the answer. A file changed
or a symlink pointed elsewhere between that decision and the launch (by a background job, or by
the call before it in the same step) could still make git run a program, and the inspection itself
misread a quoted include path containing `#`. A settled command can't depend on parsing
configuration right or on it staying the same.

### Decision

1. **A settled command runs in a form that ignores configuration that could run a program,
   whatever the files say at launch** (`spade_classify::hardening`). Spade sets, on the command:
   `GIT_CONFIG_COUNT` entries, which git reads as command-line configuration over every file
   (`core.fsmonitor=false`, `core.hooksPath=/dev/null`, `core.pager=cat`, editors and askpass
   `false`, `core.sshCommand=false`, `credential.helper=` (reset), `protocol.allow=never`, every
   `gpg` program `false`, `log.showSignature=false`); `GIT_CONFIG_NOSYSTEM=1`,
   `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_PARAMETERS=`, `GIT_PAGER=cat` (over every
   `pager.*`), `GIT_NO_LAZY_FETCH=1` and kin; and `RIPGREP_CONFIG_PATH=`, `GREP_OPTIONS=`,
   `LESSOPEN=`, `LESSKEYIN=/dev/null`, `TAR_OPTIONS=`, `ZIPOPT=`, `UNZIP=`, `AWKPATH=`, `PAGER=cat`.
2. **Only what that form covers settles.** Every program in the command must either read no such
   configuration (an explicit list: `cat`, `ls`, `find` without `-exec`, `sort` without
   `--compress-program`…) or be covered above, and only for the uses where it covers everything:
   git's reads that never run a diff, filter or merge driver (`log` and its kin without patch,
   stat or pickaxe options, `ls-files` without `-m`/`-o`, `rev-parse`, branch and tag listings,
   `config --get`, `cat-file` without filters); awk programs with no `system`, pipe, redirect,
   `getline` or program file; sed scripts that only select, print, delete or substitute; `less`
   with no `+` command but a line number. `git status`, `diff`, `show`, `blame` and every git
   write, the Node package managers, cargo, interpreters, `curl` and anything else stay with the
   reviewer: no override covers what they can run (diff and filter drivers are named in the
   repository's own files). `xargs` and `parallel`, which run a program on operands read at run
   time, never settle.
3. **Recorded, applied, checked.** The gate records the form with the settled verdict (its name in
   the verdict's reason) and hands it to the launch; the shell tool derives it again from the
   command, refuses to run if it differs, and applies it, one-shot or in the bot's terminal, which
   never carries it to the next command. After a restart a stored classifier verdict runs only in
   the form derived again and matched against its record; otherwise the person decides. With no
   form (Windows, where `/dev/null` names nothing), nothing settles.
4. **The inspection stays as a reason to abstain**, and reads git config by git's rules (quoted
   values, the escapes git knows, `#` and `;` comments only outside quotes, continuations,
   both header forms), failing closed on anything else.
5. **Calibration** chooses the low-risk and read thresholds on every calibration call, those the
   labeller can't name counted as unsafe, with the run-time checks (the hard form included)
   applied; the temperature and person threshold still fit the named calls. **The replay** counts
   a settled call with untrusted content in view as right only if it is labelled a read. **The
   labeller** no longer calls reads what writes or runs something (`sort -o`, `uniq in out`, sed's
   `w`, `e`, `r` and flags, awk's `system`, pipes and redirects, `find -fprintf`, `git --output`,
   `gh browse`, `less +!cmd`, `date -s`, `dd of=` outside the folder, `trap`, `xargs`).

### Tests

`spade-server/tests/classifier_git.rs` runs real git with the real shell tool:
`a_settled_read_ignores_a_config_file_replaced_after_the_decision` and
`a_settled_read_ignores_a_symlinked_config_pointed_elsewhere_after_the_decision` decide
`git ls-files` while the config is clean, swap in a config whose fsmonitor would leave a marker
before it launches, and check the marker never appears. Both fail with the overrides taken out.
`ambient.rs` `config_is_read_by_gits_own_quoting_and_what_it_cant_read_counts` covers the quoted
`#` include. `harden.rs` and `decide.rs` cover which commands have a form and that a settled
decision carries it.
