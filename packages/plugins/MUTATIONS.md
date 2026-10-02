# Behavior mutation checks

Run on 2026-10-02. Each fault below was applied to production code, tested through the package's public API, and reverted immediately. Every fault produced a behavior test failure, not a transform or import error.

| Deliberate fault                                   | Test that failed                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Disable relative-path containment                  | hostile component path is rejected before use                                                   |
| Remove the per-file byte cap                       | oversized manifests and files are rejected without component activation                         |
| Ignore commit/hash consent                         | consent pins the prepared commit even after the marketplace branch changes                      |
| Skip staged integrity verification                 | staged tampering and accepted content or mode tampering cannot acquire or retain trust          |
| Skip accepted integrity verification               | staged tampering and accepted content or mode tampering cannot acquire or retain trust          |
| Keep unreferenced version/staging directories      | update requires new consent for changed scripts even when version and command stay the same     |
| Omit Claude command files                          | Claude receives native commands, agents, hook matchers, skill resources and MCP config          |
| Drop native hook matchers                          | Claude receives native commands, agents, hook matchers, skill resources and MCP config          |
| Strip executable permissions during Git extraction | reviews and accepted trust survive reopening and executable bits survive Git extraction         |
| Drop OpenCode MCP environment variables            | OpenCode runtime content adds skills, command templates, subagent prompts, instructions and MCP |
| Skip streamed projection copy verification         | source tampering fails replacement while the previous generated configuration remains usable    |

Use `bun run test -- packages/plugins/src/<file>.test.ts -t '<behavior>'` to run a named behavior while reproducing a fault. The full unmutated suite must pass afterward.
