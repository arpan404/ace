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
