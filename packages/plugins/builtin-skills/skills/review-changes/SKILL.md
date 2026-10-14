---
name: review-changes
description: Review the changes in this worktree before they are committed or merged. Use when the person asks to review their changes, check a diff, or look over work before a PR.
---

# Review my changes

1. Call `ace_context` with `topics: ["changes", "notes"]`. It lists the branch, upstream, ahead/behind counts and every changed file, plus the project's notes. Don't run `git status` first.
2. Read the diff with your own tools: `git diff` for unstaged changes and `git diff --staged` for staged ones. Read the whole of each changed file where the diff alone hides the context.
3. Check each change against what it was meant to do and against the project notes. Look for:
   - wrong or missing behaviour, unhandled errors and edge cases;
   - tests that would still pass if the change were broken;
   - leftover debug code, secrets and unrelated edits.
4. Report findings ordered by severity. Give each one a file and line, what is wrong and a concrete fix. Say plainly when you found nothing serious.
5. If you learned a durable fact about the project, such as how its tests run, save it with `ace_note_add`.
