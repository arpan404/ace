# ace real smoke

Commit: 252023a2b2efc7e84abedf1ab7e47cca55294e9b
Result: FAIL
Steps: 28; threads: 2; failures: 10

## Timings

- daemonStart: 1630 ms
- cold-start: 506 ms
- catalogs-ready: 25 ms
- scan: 10881 ms
- past-sessions-scan: 26282 ms

## Failures

- step-failed: Model catalog did not report ready (1 occurrence). [Screenshot](screenshots/002-catalogs-ready.png)
- step-failed: expect(locator).toBeVisible() failed (3 occurrences). [Screenshot](screenshots/007-past-sessions-scan.png), [Screenshot](screenshots/012-skills-cold-start.png), [Screenshot](screenshots/013-slash-cold-start.png)
- step-failed: locator.hover: Timeout 15000ms exceeded. (1 occurrence). [Screenshot](screenshots/008-import.png)
- step-failed: locator.click: Timeout 15000ms exceeded. (1 occurrence). [Screenshot](screenshots/009-model-picker.png)
- error-surface: An error toast or banner is visible (2 occurrences). [Screenshot](screenshots/010-providers.png), [Screenshot](screenshots/011-usage-accounts.png)
- runner-failed: history.scan exceeded 60000ms (1 occurrence). [Screenshot](screenshots/028-deleted-thread.png)
- daemon-shutdown: Daemon failed to close cleanly (1 occurrence). [Screenshot](screenshots/028-deleted-thread.png)

Screenshots contain private conversation data. Keep this directory local.
