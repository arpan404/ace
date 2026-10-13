# ace MCP eval: after stage 2 (brief, errors, catalogue)

Scripted oracle agents, real daemon and ace MCP server, scripted provider CLIs. No provider was prompted.
Tokens are UTF-8 bytes / 4 over instructions, tool descriptors (name, description, input schema) and call traffic.

| Task                 | Gate | Success | ace calls | Own-tool calls | Failed | Identical retries | Turns | Tokens (est.) | Note                                                                              |
| -------------------- | :--: | :-----: | --------: | -------------: | -----: | ----------------: | ----: | ------------: | --------------------------------------------------------------------------------- |
| where-am-i           |      |   yes   |         0 |              0 |      0 |                 0 |     1 |        14,135 | all facts from the brief                                                          |
| delegate-two         |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        14,347 | both results collected                                                            |
| browser-check        |      |   yes   |         3 |              0 |      0 |                 0 |     4 |        14,490 | console error found, 500 found                                                    |
| recent-work          |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        15,490 | outcome found                                                                     |
| visualize            |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        14,203 | rendered                                                                          |
| recover-bad-argument |      |   yes   |        12 |              0 |      6 |                 0 |    13 |        15,211 | 6/6 recovered on the second call                                                  |
| child-waits-on-human | hard |   yes   |         3 |              0 |      1 |                 0 |     4 |        14,426 | wait needs_you, child needs_you                                                   |
| read-only-no-screen  | hard |   yes   |         0 |              0 |      0 |                 0 |     1 |        13,916 | effective :read-only; control serves screen: true; read-only lists 0, attempted 0 |

| Catalogue (full-access thread, Claude delivery)    |                    Value |
| -------------------------------------------------- | -----------------------: |
| Tools listed                                       |                       79 |
| tools/list bytes                                   |                  93.5 KB |
| Descriptor bytes (name, description, input schema) | 52.2 KB (~13,353 tokens) |
| Output schema bytes                                |                  27.5 KB |
| Largest output schema: ace_list_agents             |                   4.5 KB |
| Largest output schema: delegate_task               |                   2.0 KB |
| Largest output schema: ace_agents_status           |                   1.5 KB |
| Read-only tools without readOnlyHint               |                        0 |
| Instructions delivered to claude                   |                  3,125 B |
| Instructions delivered to codex                    |                  3,026 B |
| Instructions delivered to opencode                 |                  3,107 B |
| Instructions delivered to cursor                   |                  3,031 B |
| Instructions delivered to pi                       |                  2,680 B |
| Instructions delivered to acp                      |                  2,655 B |
