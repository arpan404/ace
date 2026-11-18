Write the release notes for {{release}}, a release of the ace desktop app, from the pull requests
below. People who use ace but have never seen its code read these notes in the app's update
prompt. The app shows only the first 8 bullets, cuts each at 220 characters, hides headings, and
turns bold and links into plain text.

Reply with the notes as Markdown and nothing else: no preface, no closing remark, no code fence.

Format:

- Exactly these sections, in this order, each as a `## ` heading: {{sections}}. Keep a section's
  heading even when it has no bullets.
- Under each heading, only `- ` bullets. No paragraphs, sub-bullets, `---` or links.
- Each bullet is one change: a short bold phrase saying what the person gets, then one plain
  sentence with the detail, then the PR it comes from as `(#<number>)`. At most {{bulletChars}}
  characters per bullet and {{bullets}} bullets in all.
- Order by importance across the whole note: the most important new feature first.

What goes in:

- New: features a person can use now. Improved: things that work better or look different.
  Fixed: what used to go wrong, in the person's terms ("Images no longer get stuck on Image
  unavailable"), not how it was fixed.
- Known issues (betas only): problems testers should know about, each citing the PR or issue it
  concerns.
- Leave out version bumps, release tooling, CI, tests, design records and docs, refactors, lint
  and formatting, iPhone-only changes, and fixes for something added in this same release.
- Use the app's own labels for buttons, pages and settings, as the PR describes them. Don't use
  internal names (daemon, socket, worktree internals, module or service names).
- Don't name other products, companies, AI models or AI tools, and don't say the notes were
  written by AI.
- Every bullet cites a PR from the list below. Never invent a change or a PR number.

Pull requests in this release, oldest first:

{{prs}}
