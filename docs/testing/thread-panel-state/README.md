# Chat panel state regression

Issue #794, PR #795.

Captured against the fake daemon after opening the right panel in the cold-start replay chat and switching to the reconnect chat at desktop width. The destination chat keeps its panel closed. The viewport is then resized to each width below to check the resulting conversation layout.

The interaction tests also cover creating a new chat and restoring each chat’s own panel visibility and selected tab on return. No layout styles changed.

| Width | Light                        | Dark                        |
| ----- | ---------------------------- | --------------------------- |
| 390   | [Screenshot](light-390.png)  | [Screenshot](dark-390.png)  |
| 768   | [Screenshot](light-768.png)  | [Screenshot](dark-768.png)  |
| 1440  | [Screenshot](light-1440.png) | [Screenshot](dark-1440.png) |
| 1920  | [Screenshot](light-1920.png) | [Screenshot](dark-1920.png) |
