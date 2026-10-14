---
name: investigate-bug
description: Investigate a bug or unexpected behaviour to its root cause before fixing it. Use when the person reports something broken, failing, slow, or wrong, including in a web page or app.
---

# Investigate a bug

1. Gather what ace already knows in one call: `ace_context` with `topics: ["recent", "notes", "diagnostics"]`. Earlier threads may have hit the same problem. Diagnostics list this session's failed ace calls and what is still running.
2. Reproduce it. For a web page, open it with `ace_browser_open`, then read `ace_browser_logs` for console errors and failed requests, and use `ace_browser_snapshot` to see the page. For code, write or run the smallest failing case.
3. Form one hypothesis at a time and test it with evidence (logs, a breakpoint, a minimal change). Note which hypotheses you ruled out.
4. Fix the root cause, not the symptom, and prove the fix by rerunning the reproduction.
5. Report the cause, the fix and the evidence. If the cause would trip up future work, save it with `ace_note_add`.
