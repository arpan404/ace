# ace MCP eval: baseline (main dcdf6861d)

Scripted oracle agents, real daemon and ace MCP server, scripted provider CLIs. No provider was prompted.
Tokens are UTF-8 bytes / 4 over instructions, tool descriptors (name, description, input schema) and call traffic.

| Task                 | Gate | Success | ace calls | Own-tool calls | Failed | Identical retries | Turns | Tokens (est.) | Note                                                                              |
| -------------------- | :--: | :-----: | --------: | -------------: | -----: | ----------------: | ----: | ------------: | --------------------------------------------------------------------------------- |
| where-am-i           |      |   yes   |         3 |              1 |      0 |                 0 |     4 |        17,000 | all facts correct                                                                 |
| delegate-two         |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        16,505 | both results collected                                                            |
| browser-check        |      |   yes   |         3 |              0 |      0 |                 0 |     4 |        16,150 | console error found, 500 found                                                    |
| recent-work          |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        17,151 | outcome found                                                                     |
| visualize            |      |   yes   |         2 |              0 |      0 |                 0 |     3 |        15,929 | rendered                                                                          |
| recover-bad-argument |      |   no    |        12 |              0 |     12 |                 6 |    13 |        16,492 | 0/6 recovered on the second call                                                  |
| child-waits-on-human | hard |   yes   |         3 |              0 |      1 |                 0 |     4 |        15,990 | wait needs_you, child needs_you                                                   |
| read-only-no-screen  | hard |   no    |         1 |              0 |      1 |                 0 |     2 |        15,817 | effective :read-only; control serves screen: true; read-only lists 1, attempted 1 |

| Catalogue (full-access thread, Claude delivery)    |                    Value |
| -------------------------------------------------- | -----------------------: |
| Tools listed                                       |                       82 |
| tools/list bytes                                   |                 173.0 KB |
| Descriptor bytes (name, description, input schema) | 58.2 KB (~14,888 tokens) |
| Output schema bytes                                |                 100.8 KB |
| Largest output schema: ace_read_handoff            |                  55.6 KB |
| Largest output schema: ace_thread_info             |                  27.2 KB |
| Largest output schema: ace_list_agents             |                   4.5 KB |
| Read-only tools without readOnlyHint               |                        0 |
| Instructions delivered to claude                   |                  3,630 B |
| Instructions delivered to codex                    |                  3,105 B |
| Instructions delivered to opencode                 |                  3,741 B |
| Instructions delivered to cursor                   |                  3,631 B |
| Instructions delivered to pi                       |                  3,136 B |
| Instructions delivered to acp                      |                  3,631 B |
