# LiteLLM price coverage

Checked 2026-11-01 against the local model catalog's visible results and the
bundled LiteLLM snapshot. The unfiltered catalog truncates additional models;
this is a coverage sample, not a claim about every installed CLI's model list.
The snapshot contains 3,671 token-priced entries. All 13 previously bundled ids
still match, including `openrouter/anthropic/claude-sonnet-4.6`.

| Catalog routes               | Priced models                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex and Pi `openai-codex/` | GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Astra, GPT-6 Luna, GPT-5.6 Terra                                                                            |
| Claude                       | Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1, plus the previously bundled Claude models                                                         |
| OpenCode Go                  | Muse Spark 1.3 Contributor, GLM 5.3 and 5.3 Flash, and all other exact `opencode_go/` entries; Beam Free has an explicit zero rate            |
| OpenCode Zen                 | `opencode/muse-spark-1.3`, `opencode/gpt-5.5` use upstream API estimates                                                                      |
| Copilot                      | `github-copilot/claude-opus-5.5`, `claude-sonnet-5.5`, `gpt-6.1-sol`, `gpt-5.3-codex`, `gpt-6-luna` map to LiteLLM's `github_copilot/` routes |
| Gemini and Antigravity       | Gemini 4 Argon, Gemini 3.8 Flash, and the other exact Gemini ids, with optional `gemini/`, `google/` or `google-gemini-cli/` prefixes         |
| Pi Ollama                    | `ollama/qwen3-coder:480b-cloud` has an explicit zero rate                                                                                     |
| OpenRouter                   | Known upstream ids use first-party API estimates when LiteLLM has no exact route rate                                                         |

The free-model catalog query still has no matching LiteLLM token price for:

- `opencode/beam-free`
- `opencode/flint-40b-free`
- `opencode/glm-5.3-flash-free`
- `opencode/deepseek-v4.1-flash-free`
- `opencode-go/iceman-contributor-free`
- `opencode/nemotron-3.5-lightning-free`
- `opencode/mimo-v2.6-flash-free`
- `opencode/nemotron-3.5-super-vl-free`

A `free` suffix alone does not create a rate. Unknown local/custom models and
provider auto selectors also remain unpriced unless an exact rate or explicit
alias exists. Cursor returned no models in this catalog read.

The existing usage benchmark, with 73,000 daily rows, measured 12,212 events/s.
Query p95s were 72.57 ms for year/provider/account summary, 34.83 ms for fortnight
series, 21.57 ms for monthly series, 90.50 ms for year daily series, 163.11 ms for
top threads and 5.72 ms for subtree series. Peak RSS was 212.8 MiB. These are
observations on the development machine, not wall-clock test assertions.
