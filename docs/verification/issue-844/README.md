# Switch preservation preference

Verified against the web app's in-page fake daemon through the collaborative preview.
The General setting saves its boolean value. Public UI regressions cover provider and account
changes with preservation enabled and disabled, model-only changes, setting persistence,
and a setting change while confirmation is open. Existing continuation regressions cover
attachments and mandatory Cursor routing. Settings service tests cover restart and scoped
overrides. No live provider CLI or subscription quota was used.

The new row fits all four widths without horizontal overflow. Its description wraps beside
the toggle at 390px; the existing settings layout handles wider viewports. Light and dark
were checked using the app's theme attributes and stylesheet. Preview captures can appear
soft at wider sizes; DOM bounds were checked separately.

| Width | Light                        | Dark                        |
| ----- | ---------------------------- | --------------------------- |
| 390   | [Screenshot](light-390.png)  | [Screenshot](dark-390.png)  |
| 768   | [Screenshot](light-768.png)  | [Screenshot](dark-768.png)  |
| 1440  | [Screenshot](light-1440.png) | [Screenshot](dark-1440.png) |
| 1920  | [Screenshot](light-1920.png) | [Screenshot](dark-1920.png) |

Focused verification passed across the initial and serial follow-up runs: 21 UI behaviors
and 11 settings-service tests. Initial UI timeouts were rerun with one worker and a
60-second test deadline. The account-fork test was corrected to assert source preservation
and lineage without depending on the fake daemon's native/portable label.

Full repository validation is tracked in the PR. A passing focused run does not replace it.
