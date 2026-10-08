# ace tool-list measurements

Measured on 2026-10-07 against baseline `88805977573795427ce056293726b89a28075aef`.
No real provider session, native app, browser or device was started. The fixture uses a temporary ace home and the daemon's registered tool catalogue.

These are comparable tokenizer estimates, not provider billing counts. Every row uses `tiktoken` 0.12.0 `o200k_base`, compact JSON, and only `name`, `description`, `inputSchema`. Native wrappers, output schemas, tool annotations and each provider's own tokenizer are excluded. Codex's baseline includes the observed server-instruction prefix on every descriptor; the other providers' baselines do not. Names use `mcp__ace__` for Codex/Claude, `ace_` for OpenCode and the advertised names for Cursor/Pi/ACP.

| Provider | Before, groups off | After, groups off | Screen enabled, no app grant | Screen approved, devices off | Native guidance, once |
| -------- | -----------------: | ----------------: | ---------------------------: | ---------------------------: | --------------------: |
| Codex    |             26,912 |             9,295 |                        9,444 |                       12,074 |                   207 |
| Claude   |             14,880 |             9,295 |                        9,444 |                       12,074 |                   209 |
| OpenCode |             14,566 |             9,105 |                        9,250 |                       11,832 |                   216 |
| Cursor   |             14,410 |             8,980 |                        9,124 |                       11,694 |                   206 |
| Pi       |             14,410 |             8,980 |                        9,124 |                       11,694 |                   212 |
| ACP      |             14,410 |             8,980 |                        9,124 |                       11,694 |                   206 |

The tool columns exclude the once-delivered native guidance in the last column. Before: 94 tools even with screen/devices disabled. After: 63 with both groups off, 64 with screen staged, 76 with a screen grant and devices off. Codex's off-state catalogue shrinks about 65%. Its old 658-character preamble cost 126 tokens alone; repeating it across the catalogue adds about 12,032 tokens under this normalization. The diagnosis's roughly 15,000-token estimate used a live provider context rather than this common tokenizer.

`apps/daemon/bench/tool-list.ts` reads baseline descriptions from this repository's git history, reconstructs the old disabled-group suffixes, and captures the current public HTTP catalogue. It writes temporary baseline modules beside the owning modules to resolve their relative imports and removes them on exit. The enabled stages are derived from the same registered catalogue with the documented capability filters.

Reproduce from the repository root (Python with `tiktoken` installed is only a measurement dependency):

```sh
node apps/daemon/bench/tool-list.ts 88805977573795427ce056293726b89a28075aef > /tmp/ace-tool-list.json
python3 - <<'PYTHON'
import json
import tiktoken
catalogue = json.load(open('/tmp/ace-tool-list.json'))
encoding = tiktoken.get_encoding('o200k_base')
for provider in ('codex', 'claude', 'opencode', 'cursor', 'pi', 'acp'):
    prefix = 'mcp__ace__' if provider in ('codex', 'claude') else 'ace_' if provider == 'opencode' else ''
    counts = []
    for stage in ('before', 'after', 'staged', 'approved'):
        tools = []
        for tool in catalogue[stage]:
            description = tool['description']
            if stage == 'before' and provider == 'codex':
                description = catalogue['oldInstructions'] + '\n\n' + description
            tools.append(dict(name=prefix + tool['name'], description=description, inputSchema=tool['inputSchema']))
        counts.append(len(encoding.encode(json.dumps(tools, separators=(',', ':'), ensure_ascii=False))))
    guidance = len(encoding.encode(catalogue['instructions'][provider]))
    print(provider, *counts, guidance)
PYTHON
```

Native delivery and catalogue refresh are tested at the SDK/CLI boundary with fakes. Live CLI consumption and provider-specific token accounting remain unverified under the task's prohibition on real provider prompts.
