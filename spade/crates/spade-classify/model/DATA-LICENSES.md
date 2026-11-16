# Data licences for the spade-classify model

`weights.bin` is trained only on data that is Spade's own, under Spade's licence (Apache-2.0):

| Source                                                                               | Where                                                        | Licence                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------- |
| Commands in Spade's classifier, effect and autonomy tests, labelled by Spade's rules | `spade/crates/spade-core`, `spade/crates/spade-server/tests` | Apache-2.0 (this repository) |
| Template-generated shell commands and tool calls, and their obfuscated forms         | `spade/tools/classify-train`                                 | Apache-2.0 (this repository) |

No public corpus is used. One may be added only under a licence compatible with Apache-2.0, recorded
here with its source, version and licence. If that's unclear, it stays out.

No model or provider was called to label or generate any of it.
