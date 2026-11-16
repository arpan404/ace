# classify-train

Builds the data for Spade's tool-call classifier (`spade-classify`, ADR 0172), trains it, calibrates
it, picks its thresholds and writes `crates/spade-classify/model/weights.bin` and `REPORT.md`.

```sh
cd spade
cargo run --release -p classify-train            # seed 172, the shipped model
cargo run --release -p classify-train -- --seed 3 --out /tmp/try
CLASSIFY_DUMP=1 cargo run --release -p classify-train   # also prints held-out mistakes
```

It runs in about a second, single-threaded, and the same seed writes the same bytes. It never
calls a model, a provider or the network.

## Where the data comes from

- **Spade's own tests** (`fixtures.rs`): every string literal in the shell classifier, effect and
  autonomy tests that parses as a command and starts with a known program, labelled by Spade's
  own rules (`spade_core::autonomy::shell::assess`). What the rules can't name is left out.
- **Templates** (`shell_families.rs`, `tool_families.rs`): shell commands and tool calls by intent:
  reads, builds, package managers, git, curl and wget, interpreters, AppleScript and JavaScript for
  Automation, sends, payments, publishes, access changes and credential reads. The label is the
  template's intent.
- **Tricks** (`obfuscate.rs`): quoting, backslashes, variables, spacing, base64 with `eval` or a
  pipe into a shell, `sh -c`, here-documents and here-strings, aliases, functions, wrappers; and,
  only ever in the adversarial test set, look-alike letters, zero-width spaces, full-width
  letters, `printf` hex, `rev` and `python -c os.system`.
- **No public corpora.** See `crates/spade-classify/model/DATA-LICENSES.md`.

## How it is split and measured

Each family's variants (shell) or base names (tools) are split about 60/20/20 between training,
validation and test, and filled from separate halves of every value list (`vocab.rs`), so no form
or value crosses sets. Validation sets the temperature and both thresholds:

- **settle as low-risk** at the lowest probability above every risky validation call, never
  below 0.95;
- **raise to the person** at the lowest probability with at least 98% precision on validation,
  never below 0.6.

Besides the threshold, the model never settles a call that points outside the bot's folders, hides
what it runs, or has a program, subcommand or flag never seen in a low-risk training command.

The shipped model is then retrained on every template with those settings. The tricks and
misleading tool names held out of training stay out of it as its own check. `REPORT.md` has every
measure.
