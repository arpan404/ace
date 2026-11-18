# classify-train

Builds the data for Spade's tool-call classifier (`spade-classify`, ADR 0172), trains it, calibrates
it, picks its thresholds and writes `crates/spade-classify/model/weights.bin` and `REPORT.md`.

```sh
cd spade
tools/classify-train/fetch-corpora.sh /var/tmp/spade-corpora      # once: tldr-pages, pinned
cargo run --release -p classify-train -- --tldr /var/tmp/spade-corpora/tldr   # the shipped model
cargo run --release -p classify-train -- --tldr DIR --seed 3 --out /var/tmp/try
# Real sessions, measured only: a read-only copy of an ace home, aggregates in REPORT.md.
tools/classify-train/real-sessions.sh ~/.ace /var/tmp/spade-real
cargo run --release -p classify-train -- --tldr DIR --real /var/tmp/spade-real
# Any model file on the realistic sets and the end-to-end replay, printed:
cargo run --release -p classify-train -- measure --weights FILE --tldr DIR --real /var/tmp/spade-real
CLASSIFY_DUMP=1 …   # also prints held-out mistakes to stderr, on this machine only
```

It runs in seconds, single-threaded, and the same seed writes the same bytes on every machine
(`exp` and `ln` are plain arithmetic). It never calls a model or a provider; the network is used
only by `fetch-corpora.sh`. `real-sessions.sh` never starts a daemon: it copies `events.sqlite`
from a read-only connection and reads only the copy. Never train on real sessions or commit
anything derived from single calls.

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
- **Agent shapes** (`agent_families.rs`): commands the way coding agents write them (chained reads,
  `2>&1 | tail`, here-document edits, reads of code about risky things, desktop input, pushes
  after commits, tokens in headers).
- **tldr-pages** (CC BY 4.0, `tldr.rs`): every example of the common, linux and osx pages, filled
  and labelled by the reference labeller (`label.rs`); one it can't name is measured as risky and
  never trained on. See `crates/spade-classify/model/DATA-LICENSES.md`.

## The realistic measures

`label.rs` is a reference labeller written for measuring: explicit tables of programs and
subcommands, Spade's own rules and tldr's descriptions. It never sees the model. Besides the
template sets the report gives a hand-labelled hard set (`hard.rs`), hand-labelled connector
calls in public MCP servers' shapes (`connectors.rs`), tldr-pages' held-out pages, and, with
`--real`, real sessions model-alone and replayed through the whole gate (`replay.rs`: Spade's
rules first, then the classifier, with untrusted content following Spade's own rule), as
recorded and with each thread placed in the folder it worked in. It also trains a small MLP on
the same data (`mlp.rs`, `compare.rs`) and compares it with the linear model.

## How it is split and measured

There is one model, and `REPORT.md` describes those exact weights:

- **fit** on the training split, the first test sets' templates and fixtures, and tldr-pages'
  training pages (three pages in five);
- **calibrated** on the validation split and tldr-pages' validation pages, which the fit never
  sees: the temperature, and the thresholds below;
- **measured** on what neither touched: the fresh pool (`fresh.rs`, `--fresh-seed`, 2026 by
  default; written after the first test sets had been looked at, a test checks it shares nothing
  with them), the tricks and misleading tools held out of every fit, tldr-pages' held-out pages,
  the hand-labelled sets, and real sessions with their end-to-end replay. Don't tune on these;
  when they have been looked at to change something, write a new fresh pool.

Each family's variants (shell) or base names (tools) are split about 60/20/20, and filled from
separate halves of every value list (`vocab.rs`), so no form or value crosses sets. The
thresholds, from the calibration calls whose effect the labels name:

- **settle as low-risk** at the lowest probability above every risky calibration call, never
  below a fixed floor of 0.95;
- **settle with untrusted content in view** only a read whose read probability alone is above
  every calibration call that isn't a read and could be settled there, by 0.02, never below 0.8;
- **raise to the person** at the lowest probability (of any person-only effect, summed) with at
  least 98% precision on the calibration data, never below 0.6.

Besides the threshold, the model never settles a call that points outside the bot's folders, hides
what it runs, or has a program, subcommand or flag never seen in a low-risk training command.

Besides those, a command that runs git, a Node package manager, cargo or ripgrep is settled only
where the gate found that tool's configuration naming no program (`spade_classify::inspect`); the
replay inspects each real folder the same way. `REPORT.md` has every measure.
