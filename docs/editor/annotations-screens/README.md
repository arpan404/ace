# Code annotations in the editor

Screens from the fake-daemon app (port 5198), with the editor mounted in a side-panel tab of a
real thread so the thread's own composer collects the annotations.

| Screen                | What it shows                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| 01-affordance-dark    | A selection, and the bar under it: Annotate, Ask about this, Fix this, Explain                     |
| 02-popover-dark       | The comment beside the code: lines, Note / Ask / Fix / Explain, Cancel, Save                       |
| 03-quick-fix-dark     | Fix this: saved at once, numbered 2, its words open to change                                      |
| 04-pins-and-chip-dark | Numbered markers left of the line numbers, a bar over the lines, the wash, and the composer's list |
| 05-outdated-dark      | The annotated line deleted: the marker stays where it was, muted, and says so                      |
| 06-affordance-light   | The bar in light                                                                                   |
| 07-edit-popover-light | A marker pressed: its comment to change or delete                                                  |
| 08-chip-list-light    | The composer's list: file and lines, first line of code, comment, Outdated                         |
| 09-queued-light       | Sent while the agent waits: the queued line counts the annotations                                 |
| 10-sent-card-light    | The sent message's card                                                                            |
| 11-sent-card-dark     | The same in dark                                                                                   |

## Mounting it

`useEditorAnnotations({ threadId, path, side? })` from `@/features/editor` returns the layer;
pass it to `CodeEditor`'s `layer` prop. It returns undefined while the thread has no composer
mounted (a new thread's draft), and the editor then draws nothing extra. `side: "old"` is for a
diff's old side. A read-only editor takes annotations too.
