# ace MCP eval: baseline (main 168d86901)

Scripted oracle agents, real daemon and ace MCP server, scripted provider CLIs. No provider was prompted.
Tokens are UTF-8 bytes / 4 over instructions, tool descriptors (name, description, input schema) and call traffic.

| Task                 | Gate | Success | ace calls | Own-tool calls | Failed | Identical retries | Turns | Tokens (est.) | Note                                                                              |
| -------------------- | :--: | :-----: | --------: | -------------: | -----: | ----------------: | ----: | ------------: | --------------------------------------------------------------------------------- |
| where-am-i           |      |   yes   |         3 |              1 |      0 |                 0 |     4 |        15,535 | all facts correct                                                                 |
| delegate-two         |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        15,041 | both results collected                                                            |
| browser-check        |      |   yes   |         3 |              0 |      0 |                 0 |     4 |        14,686 | console error found, 500 found                                                    |
| recent-work          |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        15,686 | outcome found                                                                     |
| visualize            |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        14,464 | rendered                                                                          |
| recover-bad-argument |      |   no    |        12 |              0 |     12 |                 6 |    13 |        15,027 | 0/6 recovered on the second call                                                  |
| child-waits-on-human | hard |   yes   |         3 |              0 |      1 |                 0 |     4 |        14,525 | wait needs_you, child needs_you                                                   |
| read-only-no-screen  | hard |   no    |         1 |              0 |      1 |                 0 |     2 |        14,352 | effective :read-only; control serves screen: true; read-only lists 1, attempted 1 |

| Catalogue (full-access thread, Claude delivery)    |                    Value |
| -------------------------------------------------- | -----------------------: |
| Tools listed                                       |                       81 |
| tools/list bytes                                   |                 166.8 KB |
| Descriptor bytes (name, description, input schema) | 52.6 KB (~13,472 tokens) |
| Output schema bytes                                |                 100.3 KB |
| Largest output schema: ace_read_handoff            |                  55.4 KB |
| Largest output schema: ace_thread_info             |                  27.2 KB |
| Largest output schema: ace_list_agents             |                   4.5 KB |
| Read-only tools without readOnlyHint               |                        0 |
| Instructions delivered to claude                   |                  3,435 B |
| Instructions delivered to codex                    |                  2,910 B |
| Instructions delivered to opencode                 |                  3,546 B |
| Instructions delivered to cursor                   |                  3,436 B |
| Instructions delivered to pi                       |                  2,941 B |
| Instructions delivered to acp                      |                  3,436 B |
