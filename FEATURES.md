# Features

ace is a multi-provider coding workspace. The common surface is provider sessions, streamed events, terminal and browser context, workspace-aware UI, and daemon-backed local runtime management.

Some providers expose richer native capabilities than others. ace implements provider-specific features directly where that gives a better experience than treating every provider as a generic chat process.

## Provider Feature Map

| Provider       | Status                  | Native ace support                                                                                                                                                                                                   |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex          | Deep native integration | App-server session lifecycle, structured event streaming, plugins, skills, image generation, Browser Use in ace's in-app browser, permission flows, tool output rendering, rollback/resume-oriented session handling |
| Claude         | Integrated              | Local CLI/SDK session flow, streamed conversation events, permission/request handling, models, and session orchestration                                                                                             |
| Cursor         | Integrated              | Cursor agent runtime, session metadata, permission handling, and provider event projection                                                                                                                           |
| Gemini         | Integrated              | Gemini CLI runtime, model discovery, streamed events, and provider session orchestration                                                                                                                             |
| GitHub Copilot | Integrated              | Copilot runtime sessions, event projection, and provider lifecycle management                                                                                                                                        |
| OpenCode       | Integrated              | OpenCode runtime sessions, model/provider discovery, event projection, and lifecycle management                                                                                                                      |
| Pi             | Integrated              | Pi CLI/RPC runtime, model discovery, thinking-level options, event projection, and lifecycle management                                                                                                              |

## Codex Native Features

Codex has the most complete native feature set in ace today.

- **Plugins**: Codex plugins are surfaced through ace and can be invoked from the app.
- **Skills**: Codex skills are implemented completely in the ace experience, including discovered skill commands and provider-aware slash command handling.
- **Image generation**: Image generation works inside ace, so generated visual output can be handled without leaving the app.
- **Browser Use**: Codex Browser Use is available through ace's in-app browser, keeping browser automation, inspection, and agent work in the same workspace.
- **Structured events**: Codex app-server events are projected into ace orchestration events for reliable UI state, history, and recovery behavior.

## Cross-Provider Workspace Features

These features are designed to work across providers:

- Persistent local daemon and web/desktop entry points.
- Provider setup checks through `ace doctor`.
- Session lifecycle management and recovery-oriented event projection.
- Terminal management for provider-spawned commands and shells.
- Workspace-aware file, browser, and desktop integration.
- Remote relay foundation for cross-device supervision.

## Mobile

The mobile app is in development. It is intended to extend ace into companion and remote-supervision workflows while the web and desktop apps remain the primary surfaces.

## Roadmap Direction

More provider-specific features are planned. The goal is not only to run multiple CLIs from one UI, but to expose each provider's strongest native capabilities in a way that still feels coherent inside ace.
