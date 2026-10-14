# ace MCP eval: before stage 4 (stage 2 branch, stage 4 tasks)

Scripted oracle agents, real daemon and ace MCP server, scripted provider CLIs. No provider was prompted.
Tokens are UTF-8 bytes / 4 over instructions, tool descriptors (name, description, input schema) and call traffic.

| Task                 | Gate | Success | ace calls | Own-tool calls | Failed | Identical retries | Turns | Tokens (est.) | Note                                                                             |
| -------------------- | :--: | :-----: | --------: | -------------: | -----: | ----------------: | ----: | ------------: | -------------------------------------------------------------------------------- |
| where-am-i           |      |   yes   |         0 |              0 |      0 |                 0 |     1 |        15,687 | all facts from the brief                                                         |
| delegate-two         |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        15,900 | both results collected                                                           |
| browser-check        |      |   yes   |         3 |              0 |      0 |                 0 |     4 |        16,043 | console error found, 500 found                                                   |
| recent-work          |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        17,057 | outcome found                                                                    |
| visualize            |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        15,756 | rendered                                                                         |
| recover-bad-argument |      |   yes   |        12 |              0 |      6 |                 0 |    13 |        16,764 | 6/6 recovered on the second call                                                 |
| child-waits-on-human | hard |   yes   |         3 |              0 |      1 |                 0 |     4 |        15,978 | wait needs_you, child needs_you                                                  |
| read-only-no-screen  | hard |   yes   |         0 |              0 |      0 |                 0 |     1 |        15,462 | effective read-only; control serves screen: true; read-only lists 0, attempted 0 |
| pr-and-changes       |      |   yes   |         1 |              1 |      0 |                 0 |     3 |        16,858 | PR #42 and login.ts found                                                        |
| notes-respected      |      |   no    |         0 |              2 |      0 |                 0 |     3 |        15,708 | 1 wrong test invocation(s)                                                       |
| ask-waits-on-person  |      |   no    |         0 |              0 |      0 |                 0 |     1 |        15,667 | no ace_ask for a child thread                                                    |

| Catalogue (full-access thread, Claude delivery)    |                    Value |
| -------------------------------------------------- | -----------------------: |
| Tools listed                                       |                       80 |
| tools/list bytes                                   |                  99.9 KB |
| Descriptor bytes (name, description, input schema) | 58.0 KB (~14,848 tokens) |
| Output schema bytes                                |                  27.9 KB |
| Largest output schema: ace_list_agents             |                   4.5 KB |
| Largest output schema: delegate_task               |                   2.0 KB |
| Largest output schema: ace_agents_status           |                   1.5 KB |
| Read-only tools without readOnlyHint               |                        0 |
| Instructions delivered to claude                   |                  3,357 B |
| Instructions delivered to codex                    |                  3,258 B |
| Instructions delivered to opencode                 |                  3,339 B |
| Instructions delivered to cursor                   |                  3,263 B |
| Instructions delivered to pi                       |                  2,875 B |
| Instructions delivered to acp                      |                  2,850 B |
