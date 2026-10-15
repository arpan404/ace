# New thread first-submit verification

Issue: https://github.com/arpan404/ace/issues/799

The fake app ran in Chromium at `http://127.0.0.1:5179`, isolated from the installed
daemon and provider sessions. The fake daemon held provider-capability replies before
opening `/new?project=relay`.

One Enter displayed “Preparing to send” and retained the message in the editor.
Cancel send kept the draft. Clicking Send again, pressing Enter again, and then
releasing readiness created exactly one thread with the original message. The
automated browser observations are in [results.json](results.json).

The pending state was captured at all four design widths in light and dark mode:

| Width | Light                                | Dark                                |
| ----- | ------------------------------------ | ----------------------------------- |
| 390   | [Screenshot](pending-light-390.png)  | [Screenshot](pending-dark-390.png)  |
| 768   | [Screenshot](pending-light-768.png)  | [Screenshot](pending-dark-768.png)  |
| 1440  | [Screenshot](pending-light-1440.png) | [Screenshot](pending-dark-1440.png) |
| 1920  | [Screenshot](pending-light-1920.png) | [Screenshot](pending-dark-1920.png) |

The [resulting thread](sent-dark-1440.png) shows the original message once.

This verifies the UI and wire path against the fake daemon. No real provider run or
recorder session was needed.

During appearance switching, Chromium reported one view-transition DOM-update
timeout on the heavily loaded host. The submission checks still completed.
