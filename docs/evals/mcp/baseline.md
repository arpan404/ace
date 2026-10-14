# ace MCP eval: baseline (main bb84cd3ed)

Scripted oracle agents, real daemon and ace MCP server, scripted provider CLIs. No provider was prompted.
Tokens are UTF-8 bytes / 4 over instructions, tool descriptors (name, description, input schema) and call traffic.

| Task                 | Gate | Success | ace calls | Own-tool calls | Failed | Identical retries | Turns | Tokens (est.) | Note                                                                             |
| -------------------- | :--: | :-----: | --------: | -------------: | -----: | ----------------: | ----: | ------------: | -------------------------------------------------------------------------------- |
| where-am-i           |      |   yes   |         3 |              1 |      0 |                 0 |     4 |        17,079 | all facts correct                                                                |
| delegate-two         |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        16,862 | both results collected                                                           |
| browser-check        |      |   yes   |         3 |              0 |      0 |                 0 |     4 |        16,229 | console error found, 500 found                                                   |
| recent-work          |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        17,243 | outcome found                                                                    |
| visualize            |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        16,008 | rendered                                                                         |
| recover-bad-argument |      |   no    |        12 |              0 |     12 |                 6 |    13 |        16,570 | 0/6 recovered on the second call                                                 |
| child-waits-on-human | hard |   yes   |         3 |              0 |      1 |                 0 |     4 |        16,068 | wait needs_you, child needs_you                                                  |
| read-only-no-screen  | hard |   yes   |         0 |              0 |      0 |                 0 |     1 |        15,714 | effective read-only; control serves screen: true; read-only lists 0, attempted 0 |

| Catalogue (full-access thread, Claude delivery)    |                    Value |
| -------------------------------------------------- | -----------------------: |
| Tools listed                                       |                       82 |
| tools/list bytes                                   |                 174.0 KB |
| Descriptor bytes (name, description, input schema) | 58.5 KB (~14,966 tokens) |
| Output schema bytes                                |                 101.4 KB |
| Largest output schema: ace_read_handoff            |                  55.6 KB |
| Largest output schema: ace_thread_info             |                  27.8 KB |
| Largest output schema: ace_list_agents             |                   4.5 KB |
| Read-only tools without readOnlyHint               |                        0 |
| Instructions delivered to claude                   |                  3,630 B |
| Instructions delivered to codex                    |                  3,105 B |
| Instructions delivered to opencode                 |                  3,741 B |
| Instructions delivered to cursor                   |                  3,631 B |
| Instructions delivered to pi                       |                  3,136 B |
| Instructions delivered to acp                      |                  3,631 B |
