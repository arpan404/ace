---
name: prepare-pr
description: Get this thread's work ready for a pull request and open or update it. Use when the person asks to open a PR, prepare changes for review, or ship the branch.
---

# Prepare a pull request

1. Call `ace_context` with `topics: ["changes", "prs", "notes"]`.
   - `changes` gives the branch, ahead/behind and changed files.
   - `prs` shows whether this work already has a PR, and its CI state. Update that PR rather than opening a second one.
2. Check the work: run the project's checks the way its notes say, and review the diff (see the review-changes skill). Fix what fails before opening the PR.
3. Commit with a clear message, push the branch, and open the PR with your own tools (for example `gh pr create`). The description says what changed, why, and how it was verified.
4. Link it to this thread with `ace_thread_link_pr` and its URL, so the person sees it in ace.
5. Report the PR link and anything still open, such as CI that is pending.
