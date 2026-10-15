# ace MCP eval: after agent skills (lean guidance, guides, compact schemas, core tools)

Scripted oracle agents, real daemon and ace MCP server, scripted provider CLIs. No provider was prompted.
Tokens are UTF-8 bytes / 4 over instructions, tool descriptors (name, description, input schema) and call traffic.

| Task                 | Gate | Success | ace calls | Own-tool calls | Failed | Identical retries | Turns | Tokens (est.) | Note                                       |
| -------------------- | :--: | :-----: | --------: | -------------: | -----: | ----------------: | ----: | ------------: | ------------------------------------------ |
| where-am-i           |      |   yes   |         0 |              0 |      0 |                 0 |     1 |        14,438 | all facts from the brief                   |
| delegate-two         |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        14,650 | both results collected                     |
| browser-check        |      |   yes   |         3 |              0 |      0 |                 0 |     4 |        14,794 | console error found, 500 found             |
| recent-work          |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        14,502 | outcome found                              |
| visualize            |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        14,506 | rendered                                   |
| recover-bad-argument |      |   yes   |        12 |              0 |      6 |                 0 |    13 |        15,515 | 6/6 recovered on the second call           |
| child-waits-on-human | hard |   yes   |         3 |              0 |      1 |                 0 |     4 |        14,729 | wait needs_you, child needs_you            |
| pr-and-changes       |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        14,522 | PR #42 and login.ts found                  |
| notes-respected      |      |   yes   |         0 |              1 |      0 |                 0 |     2 |        14,484 | 0 wrong test invocation(s)                 |
| ask-waits-on-person  |      |   yes   |         1 |              0 |      0 |                 0 |     2 |        14,646 | while asking: needs_you; answer ["GitHub"] |

| Catalogue (full-access thread, Claude delivery)    |                    Value |
| -------------------------------------------------- | -----------------------: |
| Tools listed                                       |                       99 |
| tools/list bytes                                   |                 103.0 KB |
| Descriptor bytes (name, description, input schema) | 54.9 KB (~14,051 tokens) |
| Output schema bytes                                |                  31.0 KB |
| Largest output schema: ace_list_agents             |                   4.5 KB |
| Largest output schema: ace_context                 |                   2.3 KB |
| Largest output schema: delegate_task               |                   2.0 KB |
| Read-only tools without readOnlyHint               |                        0 |
| Instructions delivered to claude                   |                  1,549 B |
| Instructions delivered to codex                    |                  1,512 B |
| Instructions delivered to opencode                 |                  1,470 B |
| Instructions delivered to cursor                   |                  1,393 B |
| Instructions delivered to pi                       |                    931 B |
| Instructions delivered to acp                      |                    908 B |
