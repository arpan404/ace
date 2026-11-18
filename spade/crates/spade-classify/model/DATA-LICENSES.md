# Data licences for the spade-classify model

`weights.bin` is trained on Spade's own data (Apache-2.0) and on one public corpus whose licence is
compatible with it:

| Source | Where | Licence |
| --- | --- | --- |
| Commands in Spade's classifier, effect and autonomy tests, labelled by Spade's rules | `spade/crates/spade-core`, `spade/crates/spade-server/tests` | Apache-2.0 (this repository) |
| Template-generated shell commands and tool calls, and their obfuscated forms | `spade/tools/classify-train` | Apache-2.0 (this repository) |
| tldr-pages, `pages/{common,linux,osx}` at commit `70eef449485e3240f3bd00f02734fe12257ed735`, placeholders filled and labelled by `classify-train/src/label.rs` | <https://github.com/tldr-pages/tldr>, fetched by `classify-train/fetch-corpora.sh`, not committed | CC BY 4.0 |

tldr-pages: Copyright © 2014–present the tldr-pages team and contributors, licensed under the
[Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/).
The model learns from its example commands; no page text is shipped. Changes made: placeholders
filled with plain values, and each command labelled by Spade's reference labeller.

Measured on, never trained on:

| Source | Where | Licence |
| --- | --- | --- |
| The hand-labelled hard set and connector set | `classify-train/src/hard.rs`, `connectors.rs` | Apache-2.0 (this repository) |
| Real coding-agent sessions on the machine that trains the model | read from a read-only copy of an ace home by `classify-train/real-sessions.sh`; never committed; only aggregate numbers are reported | the person's own data |

Left out: NL2Bash (<https://github.com/TellinaTool/nl2bash>) is GPL-3.0. Another corpus may be
added only under a licence compatible with Apache-2.0, recorded here with its source, version and
licence. If that's unclear, it stays out.

No model or provider was called to label or generate any of it.
