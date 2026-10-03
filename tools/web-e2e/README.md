# @ace/web-e2e

End-to-end tests for the web app (`apps/web`) in Chromium, with Playwright.

| Project       | What it drives                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fake`        | The app against the in-page fake daemon (`vite --mode fake`): the core journeys, in `e2e/fake/`.                                                                                            |
| `real-daemon` | The app against a real `apps/daemon` whose providers are scripted adapters from `@ace/adapter-testkit` (`src/real-daemon.ts`). No provider CLI is started and no prompt leaves the machine. |
| `screens`     | Every screen in Dark and Light at 1440x900, written to `/tmp/aceshots-web/<screen>-<theme>.png` (`ACE_SHOTS_DIR` overrides).                                                                |

```sh
bun run web:e2e       # fake + real-daemon
bun run web:screens   # screenshots
```

Playwright starts the two Vite servers (ports 5190 fake, 5191 real) and the daemon (port 4391,
home in the system temp dir) itself. The browsers come from the shared Playwright cache; run
`bunx playwright install chromium` once if it is missing.
