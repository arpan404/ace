# Mutation verification

Each mutation below was applied to production code, killed by the named public behavior test, and reverted. All runs used Vitest with one worker.

- insertion offset removed: `follows an insertion above` failed.
- deletions stay active: `keeps the last position` failed.
- fuzzy fallback disabled: `matches small edits` failed.
- ambiguous text picks first destination: `does not guess` failed.
- changed findings remain active: `matches small edits` failed.
- suggestion text corrupted: `applies a suggestion through git` failed.
- resolution inverted: `comments replies resolution` failed.
- reviewer validation bypassed: `reviewer output rejects` failed.
- oversized excerpt emitted: `fix payloads cap excerpts` failed.
- SQLite persistence replaced by memory: `comments replies resolution` failed.
