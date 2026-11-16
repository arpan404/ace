# The market scanner

The scanner (ADR 0173 §8) is one pure module the Worker, the signer and the device all run on the
same bytes. Each **check** answers `pass`, `warn` or `block` from its findings; each **finding** is
one plain sentence with a path and line where it has one (`scripts/setup.sh line 4 downloads a
script and runs it`). It reads in budgeted steps so a Worker request never reads more than it may,
and the same steps run whole on the signer and the device.

## What runs where

- `scanEntry(input)` — a whole scan, as the signer and the device run it.
- `scanStep(state, input, budget)` / `finishScan(state, input)` — the budgeted form the Worker
  runs across requests. `state` is plain JSON and round-trips through `JSON.stringify` between
  steps; `scanStep` reads files from its cursor until a budget of text bytes or files is spent, and
  `finishScan` runs the checks that need the whole entry (declared hosts, typosquats, the recipe,
  known-bad). A Worker request's budget is 4 MiB of text or 600 files; the signer and device use
  no bound. At most 1 MiB is read per file; past that a script is a `warn` ("too long to read
  fully").
- `scanListing(listing, context)` — a listing edit: hidden unicode, links, impersonation.
- `knownBad(files, hash, blocklist)` — the known-bad check alone, for re-checking installed bytes
  when a new blocklist arrives.
- `disposition(report, publisher)` — what a report means for listing: a block refuses, a warn
  holds unless a maintainer already approved the version, a new publisher's first version and its
  `strict` notes hold, and every official version holds.

## The checks

| Check       | What it reads                                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`     | Native programs by magic bytes (Mach-O incl. fat, ELF, PE, Java class), WASM outside a plugin, compiled AppleScript, nested archives (zip, gzip, tar, 7z, rar, xz, bzip2, xar, dmg), an executable bit where the type has none, and a Suit holding anything but its own file kinds. |
| `scripts`   | Skill scripts, plugin hook and stdio server commands, and recipe-bundled skills, read through the shell reader and by token patterns. Rule table in `rules-scripts.ts`.                                                                                                             |
| `scene`     | A Suit's scene JS: network, workers and shared memory, `eval`/`Function`/string timers, WebAssembly, parent-frame access, and loops with no yield.                                                                                                                                  |
| `plugin`    | A plugin's declared commands and hosts against what its files hold and do. Rule table in `rules-plugin.ts`.                                                                                                                                                                         |
| `recipe`    | A recipe's needs against its task, and prompt injection in the task, notes and `SKILL.md`. Rule table in `rules-recipe.ts`; also run over skills and plugins so their `SKILL.md` is read.                                                                                           |
| `secrets`   | `secrets.ts`'s key, token and credential-file patterns over every text file.                                                                                                                                                                                                        |
| `hidden`    | Bidirectional controls and zero-width or tag characters in code and names, mixed-script words in titles and display names, typosquats by confusable skeleton, and a title reading as "ace".                                                                                         |
| `known-bad` | The maintainers' signed blocklist: content hash, file sha256 and literal patterns.                                                                                                                                                                                                  |

### Reading scripts

Shell rules read through `shell.ts`, a TypeScript port of Spade's shell reader
(`spade_core::autonomy::shell::parse`): quoting and escapes undone, pipes, `$(…)`, `sh -c` strings
and wrappers (`env`, `sudo`, `nohup`, `xargs`, `timeout`, `exec`, `command`, `nice`…) unwrapped to
what they run, with `${IFS}` and empty quotes folded first, so `c''url ${IFS}x|b\ash` reads as
`curl x | bash`. A pipe into a shell is an ordinary pipe, so a rule sees the first command's
`pipedInto`. Text the reader truly can't read (an unterminated quote, a backtick, `<(…)`, nesting
past its depth) sets `unreadable`, itself a finding, and the reader still returns the commands it
could read. Other languages are read by token patterns over NFKC-normalised text with zero-width
characters removed.

### The rule framework

The `scripts`, `plugin` and `recipe` rule tables plug into one framework so each table is edited on
its own (`rule.ts`, `script-view.ts`):

- `ScriptView` (`script-view.ts`) — one script the scanner reads: `path`, `language`, NFKC `text`,
  `lines`, shell `commands` (each `{ words, piped, pipedInto?, writesTo, readsFrom, line }`), and
  `unreadable`. `viewsOf(input)` yields a view for every skill script, plugin script file, hook and
  stdio command, and recipe-bundled skill script.
- `ScriptRule` (`rule.ts`) — `{ kind: "script", id, check, level, strict?, find(view) }`, run over
  every script view.
- `EntryRule` (`rule.ts`) — `{ kind: "entry", id, check, level, strict?, find(input, facts) }`, run
  once over the whole entry with the gathered `ScanFacts` (the URL hosts seen in code).

## Measured coverage

The corpus is written for these tests; no sample runs and none carries real malware. The benign
samples are in `corpus-benign.ts`, the malicious ones in `corpus-malicious.ts`.

| Corpus                            | Samples                               | Result                                                                 |
| --------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| Malicious (`corpus-malicious.ts`) | 85 across 24 categories               | **100% caught** (every sample blocked or held), every category covered |
| Benign (`corpus-benign.ts`)       | 40 skills, plugins, Suits and recipes | **0 blocked, 0 warned** (0% false positives)                           |

Detection counts a sample as caught when `disposition` returns something other than `list` for an
ordinary publisher (`newPublisher: false`), i.e. the scan itself blocked or held it, never relying
on a new-publisher hold. The thresholds the tests enforce are at least 95% detection and zero
benign blocks.

### Reproducing

```sh
bun --bun x vitest run packages/marketplace/src/scan packages/marketplace/src/profile.test.ts
```

- `detection.test.ts` scans the malicious corpus and asserts ≥ 95% caught and every category hit.
- `corpus-benign.test.ts` scans the benign corpus and asserts zero blocks.
- `shell.test.ts`, `text.test.ts`, `scanner.test.ts` and `profile.test.ts` cover the reader, the
  folding, the checks, the report, the disposition and the profile rules, including an adversarial
  table of obfuscated variants and a proof that a 1 MiB adversarial line finishes fast.
