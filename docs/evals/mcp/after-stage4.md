# ace MCP eval: after stage 4 (knowledge, notes, skills, ask, diagnostics)

Scripted oracle agents, real daemon and ace MCP server, scripted provider CLIs. No provider was prompted.
Tokens are UTF-8 bytes / 4 over instructions, tool descriptors (name, description, input schema) and call traffic.

| Task                 | Gate | Success | ace calls | Own-tool calls | Failed | Identical retries | Turns | Tokens (est.) | Note                                                                              |
| -------------------- | :--: | :-----: | --------: | -------------: | -----: | ----------------: | ----: | ------------: | --------------------------------------------------------------------------------- |
| where-am-i           |      |   yes   |         0 |              0 |      0 |                 0 |     1 |        16,067 | all facts from the brief                                                          |
| delegate-two         |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        16,280 | both results collected                                                            |
| browser-check        |      |   yes   |         3 |              0 |      0 |                 0 |     4 |        16,423 | console error found, 500 found                                                    |
| recent-work          |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        16,132 | outcome found                                                                     |
| visualize            |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        16,136 | rendered                                                                          |
| recover-bad-argument |      |   yes   |        12 |              0 |      6 |                 0 |    13 |        17,144 | 6/6 recovered on the second call                                                  |
| child-waits-on-human | hard |   yes   |         3 |              0 |      1 |                 0 |     4 |        16,358 | wait needs_you, child needs_you                                                   |
| read-only-no-screen  | hard |   yes   |         0 |              0 |      0 |                 0 |     1 |        15,849 | effective :read-only; control serves screen: true; read-only lists 0, attempted 0 |
| pr-and-changes       |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        16,152 | PR #42 and login.ts found                                                         |
| notes-respected      |      |   yes   |         0 |              1 |      0 |                 0 |     2 |        16,113 | 0 wrong test invocation(s)                                                        |
| ask-waits-on-person  |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        16,291 | while asking: needs_you; answer ["GitHub"]                                        |

| Catalogue (full-access thread, Claude delivery)    |                    Value |
| -------------------------------------------------- | -----------------------: |
| Tools listed                                       |                       83 |
| tools/list bytes                                   |                 104.4 KB |
| Descriptor bytes (name, description, input schema) | 59.3 KB (~15,181 tokens) |
| Output schema bytes                                |                  30.6 KB |
| Largest output schema: ace_list_agents             |                   4.5 KB |
| Largest output schema: ace_context                 |                   2.3 KB |
| Largest output schema: delegate_task               |                   2.0 KB |
| Read-only tools without readOnlyHint               |                        0 |
| Instructions delivered to claude                   |                  3,544 B |
| Instructions delivered to codex                    |                  3,445 B |
| Instructions delivered to opencode                 |                  3,526 B |
| Instructions delivered to cursor                   |                  3,450 B |
| Instructions delivered to pi                       |                  3,099 B |
| Instructions delivered to acp                      |                  3,074 B |
