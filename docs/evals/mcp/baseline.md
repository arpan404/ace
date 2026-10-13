# ace MCP eval: baseline (main 888534473)

Scripted oracle agents, real daemon and ace MCP server, scripted provider CLIs. No provider was prompted.
Tokens are UTF-8 bytes / 4 over instructions, tool descriptors (name, description, input schema) and call traffic.

| Task                 | Gate | Success | ace calls | Own-tool calls | Failed | Identical retries | Turns | Tokens (est.) | Note                                                                              |
| -------------------- | :--: | :-----: | --------: | -------------: | -----: | ----------------: | ----: | ------------: | --------------------------------------------------------------------------------- |
| where-am-i           |      |   yes   |         3 |              1 |      0 |                 0 |     4 |        14,991 | all facts correct                                                                 |
| delegate-two         |      |   yes   |         5 |              0 |      0 |                 0 |     4 |        14,515 | 2 children settled                                                                |
| browser-check        |      |   yes   |         3 |              0 |      0 |                 0 |     4 |        14,143 | console error found, 500 found                                                    |
| recent-work          |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        15,142 | outcome found                                                                     |
| visualize            |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        13,921 | rendered                                                                          |
| recover-bad-argument |      |   no    |        12 |              0 |     12 |                 6 |    13 |        14,483 | 0/6 recovered on the second call                                                  |
| child-waits-on-human | hard |   yes   |         3 |              0 |      1 |                 0 |     3 |        13,925 | child state waiting_on_human                                                      |
| read-only-no-screen  | hard |   no    |         1 |              0 |      1 |                 0 |     2 |        13,809 | effective :read-only; control serves screen: true; read-only lists 1, attempted 1 |

| Catalogue (full-access thread, Claude delivery)    |                    Value |
| -------------------------------------------------- | -----------------------: |
| Tools listed                                       |                       83 |
| tools/list bytes                                   |                 163.9 KB |
| Descriptor bytes (name, description, input schema) | 50.9 KB (~13,022 tokens) |
| Output schema bytes                                |                 100.6 KB |
| Largest output schema: ace_read_handoff            |                  55.4 KB |
| Largest output schema: ace_thread_info             |                  27.0 KB |
| Largest output schema: ace_list_agents             |                   4.5 KB |
| Read-only tools without readOnlyHint               |                        0 |
| Instructions delivered to claude                   |                  3,059 B |
| Instructions delivered to codex                    |                  2,534 B |
| Instructions delivered to opencode                 |                  3,170 B |
| Instructions delivered to cursor                   |                  3,060 B |
| Instructions delivered to pi                       |                  2,565 B |
| Instructions delivered to acp                      |                  3,060 B |
