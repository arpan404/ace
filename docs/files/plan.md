# Rust files and editor core: build plan

ADR 0178 records the decision. This file is the contract every builder works from. If something
here is wrong or missing, stop and say so in your final message; never invent a different
interface.

## Why

The Files panel lists the checkout with one capped walk (`list`, 1,000 paths, breadth-first), so
large checkouts show half-filled folders, the tree never updates when agents write files, and
the TypeScript watcher and path index have known gaps. ace replaces listing, watching, the path
index, content search and file I/O with a Rust process, `ace-files`, and replaces the text view
with an editor whose core is Rust compiled to Wasm. The bar is VS Code: open any folder of any
checkout instantly, see changes within ~100 ms, quick-open over a million paths without lag.

Use existing, well-maintained crates for every hard part. Write glue, not engines.

## Layout

```
native/files/                 Cargo workspace (own Cargo.lock), bun run check:files
  crates/files-safe           root confinement: every relative path resolves inside the root
  crates/files-list           one folder per request, paged, git-ignore aware, VS Code order
  crates/files-watch          recursive watching, coalesced batches, overflow -> rescan
  crates/files-index          quick-open path index: parallel walk, fuzzy match, live updates
  crates/files-search         content search in-process (ripgrep's libraries)
  crates/files-io             read ranges, encoding/binary detection, atomic writes, mutations
  crates/files-wire           the daemon <-> ace-files protocol: frames, messages, golden vectors
  crates/ace-files            the binary (wave 2): tokio runtime, dispatch, subscriptions
  vectors/                    golden wire vectors, shared with the TypeScript client
native/editor/                Cargo workspace built to wasm32-unknown-unknown
  crates/editor-core          text buffer, edits, undo, selections, find, line index
  crates/editor-diff          gutter marks against the original text
  crates/editor-wasm          wasm-bindgen surface (wave 2)
packages/files-native         (wave 2) daemon-side supervisor and typed client for ace-files
packages/editor               (wave 2) Wasm loader and TypeScript bindings
```

Syntax highlighting is markit's (syntect, TextMate grammars, same colours as chat). markit gains
a line-level incremental API (see "markit"); the editor never carries a second highlighter.

## Rules for every builder

1. Scope: touch only the paths your brief names. Never edit another crate, `Cargo.toml` at the
   workspace root, `apps/`, or other `packages/`. Never hand-edit `Cargo.lock`; let cargo write it.
2. Crates: prefer the crates listed per section. Before adding any other dependency, check its
   licence is in `deny.toml` (`Apache-2.0`, MIT, BSD, ISC, Zlib, Unicode-3.0, Unlicense, and
   CC0-1.0 in `native/files` only). MPL-2.0, GPL, LGPL, AGPL, SSPL: never. No git dependencies
   except markit in `native/editor`.
3. Lints are workspace-wide and deny: no `unsafe`, no `unwrap`/`expect` outside tests, clippy
   `all`. Every crate's `Cargo.toml` has `[lints] workspace = true`, `edition.workspace = true`,
   `license.workspace = true`, `version.workspace = true`, `publish.workspace = true`,
   `rust-version.workspace = true`, and starts with `# SPDX-License-Identifier: Apache-2.0`.
   Every `.rs` file starts with `// SPDX-License-Identifier: Apache-2.0`.
4. Errors: one `thiserror` enum per crate. Each error has `pub fn code(&self) -> &'static str`
   returning one of: `INVALID_PATH`, `PATH_ESCAPE`, `PATH_CHANGED`, `NOT_FOUND`, `NOT_DIRECTORY`,
   `NOT_FILE`, `PERMISSION_DENIED`, `CONFLICT`, `TOO_LARGE`, `INVALID_ARGUMENT`,
   `INVALID_CURSOR`, `LIMIT_EXCEEDED`, `ABORTED`, `UNSUPPORTED`, `IO_ERROR`. Map `io::ErrorKind`
   the obvious way. Never panic on input; malformed input is an error value.
5. Paths: library APIs take the canonical root `&Path` plus relative paths as `&str`, `/`
   separated, no leading `/`, no `.`/`..` segments, no NUL, never ending in `/`. Results carry
   the same form. Only `files-safe` validates and confines; other crates call it.
6. Injected effects: no global clocks or randomness in logic. Time comes from a parameter or a
   `Clock` trait the caller passes; tests use a fake clock.
7. Size: no source file over 400 lines; split by responsibility. Keep the public surface small and
   documented with `///` comments that say what and why in plain words. No commented-out code, no
   narrating comments, no TODOs.
8. Tests: behaviour tests through the public API on real temp directories (`tempfile`). Name them
   after the behaviour (`lists_folders_before_files_in_natural_order`). No tests that only check
   that a type exists or restate a constant. Every test in your brief's acceptance list must exist
   and pass.
9. Load: this Mac is shared and heavily loaded. Always `export CARGO_BUILD_JOBS=2`. Run only your
   own crate: `cargo fmt --all --check`, `cargo clippy -p <crate> --all-targets --locked` (first
   run without `--locked` to create the lockfile entries), `cargo test -p <crate>`. Never run
   `bun run test`, `bun run check`, vitest, or the whole workspace's tests. Benches run once,
   `--release`, and their numbers go in your final message.
10. Git: work in your own worktree on the branch your brief names. Commit after each meaningful
    step with a plain imperative message ending in the trailer
    `Co-Authored-By: spade <bot@acehq.dev>` and nothing else (no other trailers, no tool names).
    Push with an explicit refspec, `git push origin HEAD:<your-branch>`, and check
    `git rev-parse HEAD origin/<your-branch>` match. Never rebase or force-push. Never touch
    `main`. Don't open a PR; the orchestrator merges.
11. Finish: your final message lists what you built, the public API, each acceptance test name,
    bench numbers, any dependency you added with its licence, and anything you could not do.

## Wave 1 crates

### files-safe

Crates: `cap-std`, `cap-fs-ext`, `thiserror`, `rustix` (Apple, for `F_GETPATH`), `winx` and
`same-file` (Windows, for the handle's path and for file identity). API:

```rust
pub struct Root;                                     // Clone, Send, Sync
impl Root {
    pub fn open(path: &Path) -> Result<Root, Error>;     // canonicalizes; must be a directory
    pub fn path(&self) -> &Path;                         // canonical absolute root
    pub fn dir(&self) -> &cap_std::fs::Dir;              // capability handle for I/O crates
    pub fn check(rel: &str) -> Result<&str, Error>;      // syntax only (rule 5); "" is the root
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, Error>; // absolute, symlinks resolved,
                                                         // PATH_ESCAPE if it leaves the root;
                                                         // read-only walkers only
    pub fn open_dir(&self, rel: &str) -> Result<cap_std::fs::Dir, Error>; // handle to that folder
    pub fn open_parent(&self, rel: &str)
        -> Result<(cap_std::fs::Dir, String), Error>;    // parent handle plus the leaf name
    pub fn relative(&self, absolute: &Path) -> Option<String>;  // inverse; None outside root
}
```

Every lookup starts at `root.dir()` and steps down segment by segment with `symlink_metadata`,
`read_link_contents` and `open_dir_nofollow`; no lookup is driven by a path string. The walk holds
one open folder handle at a time and remembers only names, so a deep path cannot exhaust
descriptors; `..` re-opens the parents it needs. An absolute link target is compared as text
against the root (canonical and as opened) and its remainder is walked from the root again, so
nothing outside the root is ever stat'd. Every segment a link target introduces goes through the
same name rules as a request, and a target part that is not text is `PATH_ESCAPE`. One walk is
capped at 256 segments, request and targets together, and beyond that is `LIMIT_EXCEEDED`. If the
folder behind the handle is no longer what `path()` names (the root was moved and replaced by a
link), every call is `PATH_CHANGED`.

`resolve` returns the names the disk stores, never the spelling the caller used. A folder the walk
opened is named from the handle itself (`F_GETPATH` on Apple, the final path name on Windows);
anything else is matched against the folder's entries by identity — device and inode on Unix, the
folded name on Windows — and a listing with no matching entry is `PATH_CHANGED`, never a guess.
Listings are cached per root, stamped with the folder's identity and modification time, so
resolving twenty thousand entries of one folder lists it once. `relative` only returns strings
`check` accepts.

I/O goes through handles, never through a resolved path: `open_dir` for a folder and
`open_parent` for a leaf (which is returned as a name and never followed, so a dangling link is a
file to delete, not a target to resolve). Readers open the leaf through the returned handle with
no link following, and mutations create with `O_EXCL`/no-follow. `resolve` is left for read-only
walkers such as a lister, the path index or a content search, which must run with
`follow_links(false)` and compare each opened file's identity with the entry they walked.

On Windows also reject `\`, `:`, `~` (8.3 short names), drive prefixes, reserved device names
(`CON`, `NUL`, `COM1`, `COM¹`, ...) and trailing dots or spaces, matching
`packages/workspace/src/path-policy.ts`. Acceptance: `rejects_dot_dot_and_absolute_paths`,
`rejects_symlink_that_leaves_root`, `follows_symlink_that_stays_inside_root`,
`resolves_missing_leaf_under_existing_parent`, `relative_round_trips_resolve`,
`root_must_be_a_directory`, `refuses_a_root_that_was_moved_and_replaced_by_a_link`,
`refuses_an_absolute_link_that_climbs_out`, `refuses_an_inside_link_that_reaches_an_outside_link`,
`open_parent_never_follows_the_leaf`, `returns_the_name_the_folder_stores`,
`stored_names_do_not_mix_up_lookalikes`, `refuses_a_walk_deeper_than_the_limit`,
`refuses_a_windows_style_link_target`. Bench: resolving every entry of a 20,000-entry folder, with
the listing-per-entry behaviour it replaced for comparison.

### files-list

Crates: `files-safe` (path dependency), `ignore`, `natord` (or an equivalent MIT natural sort).

```rust
pub struct Lister;                                   // Send + Sync, one per root
impl Lister {
    pub fn new(root: files_safe::Root) -> Lister;
    pub fn list(&self, dir: &str, options: &ListOptions) -> Result<Page, Error>;
    pub fn stat(&self, path: &str) -> Result<Entry, Error>;
    pub fn invalidate(&self, dirs: &[&str]);         // drops cached ignore rules / snapshots
}
pub struct ListOptions { pub limit: usize, pub cursor: Option<String>, pub hide: Vec<String> }
pub struct Page { pub entries: Vec<Entry>, pub next_cursor: Option<String>, pub total: usize }
pub struct Entry { pub path: String, pub name: String, pub kind: Kind, pub size: u64,
                   pub mtime_ms: i64, pub ignored: bool }
pub enum Kind { File, Directory, Symlink { target: Option<Box<Kind>> }, Other }
```

Behaviour: one folder, not recursive. Ignored entries are listed with `ignored: true` (the UI dims
them, as VS Code does). Ignore rules are git's: every `.gitignore` from the root down, `.git/info/
exclude`, and `core.excludesFile`, built with `ignore::gitignore::GitignoreBuilder` and cached per
folder. `hide` holds glob patterns that never list (default caller value `[".git", ".DS_Store"]`).
Order: folders first, then files; within each, case-insensitive natural order (`file2` before
`file10`), ties broken by exact name. `limit` 1..=5000 (else `INVALID_ARGUMENT`). The cursor is
opaque and encodes the folder's mtime and position; a cursor for a folder that changed since is
`INVALID_CURSOR`. A symlink reports its target kind without following it outside the root.
Acceptance: `lists_one_level_only`, `lists_folders_before_files_in_natural_order`,
`marks_gitignored_entries_without_hiding_them`, `nested_gitignore_applies_to_its_folder_only`,
`hide_patterns_never_list`, `pages_through_a_folder_of_12000_files_without_gaps_or_repeats`,
`cursor_from_a_changed_folder_is_rejected`, `symlink_reports_target_kind`,
`listing_a_file_is_not_directory`. Bench: list a folder of 100,000 files, first page of 500.

### files-watch

Crates: `notify` (the polling fallback), `files-safe`, `globset`; on Linux `rustix`, which reads
inotify directly because `notify` always registers `IN_OPEN` and every file a search or the
index walk opens would wake the watcher; on macOS
`objc2-core-services` and `dispatch2` for FSEvents; on Windows `windows-sys`.

```rust
pub struct Watcher;                                  // drop = stop
impl Watcher {
    pub fn start(root: files_safe::Root, options: WatchOptions,
                 sink: Box<dyn Fn(Batch) + Send + Sync>) -> Result<Watcher, Error>;
    pub fn mode(&self) -> Mode;                      // Native | Polling
}
pub struct WatchOptions { pub debounce: Duration, pub exclude: Vec<String>, pub max_batch: usize }
pub enum Batch { Changes(Vec<Change>), Rescan { dir: Option<String> }, Warning(String) }
pub struct Change { pub path: String, pub kind: ChangeKind, pub directory: bool }
pub enum ChangeKind { Created, Modified, Deleted }
```

Behaviour: watches the whole root recursively. Defaults the caller passes: debounce 75 ms,
exclude `["**/.git/objects/**", "**/.git/subtree-cache/**", "**/node_modules/*/**"]`, max_batch
5,000. A rename is a `Deleted` plus a `Created`. Coalesce within a window: created then deleted
drops both; deleted then created is `Modified`; repeated modifies are one. More than `max_batch`
changes in one window, or an OS overflow signal (inotify `Q_OVERFLOW`, FSEvents must-scan), sends
`Rescan` for the narrowest folder known, `None` for the whole root. Linux: never add inotify
watches inside excluded folders; walk with per-folder non-recursive watches (each folder opened
from its parent's handle, so a million-file checkout starts watching in about a second) and add
new folders as they appear. If native watching cannot start or hits the inotify limit, fall back to notify's
`PollWatcher` (2 s) and send one `Warning` saying why. Paths outside the root (symlink targets) are
never reported.

macOS: files-watch owns its FSEvents stream rather than using notify's (notify starts at
`kFSEventStreamEventIdSinceNow`, drops records with no item flag and only rescans on must-scan).
The stream is created and started on its own serial dispatch queue before `start` returns, from
`FSEventsGetCurrentEventId()` read first, so fseventsd replays anything written after the call;
flags `FileEvents | NoDefer | WatchRoot`, latency 20 ms. `UserDropped`, `KernelDropped`,
`EventIdsWrapped` and `RootChanged` rescan the root; `MustScanSubDirs`, `Mount`, `Unmount` and a
record with no item flag (FSEvents' folder-level record) rescan the folder named. Stop is
stop, invalidate, an empty `dispatch_sync` on the queue, release: no callback runs after it.
Windows: its own `ReadDirectoryChangesW` backend, because notify hides the lost-event statuses.
An error event from an OS watch (an inotify read failure) rescans the root; poller errors are per
path and lose nothing.

Safety net (all platforms): fseventsd is one process serving every client, and on a loaded Mac it
was measured handing a write over 107 s late after a 20,000-file burst elsewhere on the volume,
with no lost-events flag. `Watcher::focus(folders)` (ace-files op `focus { root, folders }`, sent
by the daemon's folder watch as the union of every client's `files.watch` set, at most 512, and
sent again after an ace-files restart) names the open folders. The watcher keeps, for each of them
and the root, a stamp (identity and mtime) and the names the caller has been told it holds: the
listing when it was opened, updated by every delivered batch, and read again as a rescan covering
it is delivered, before the caller hears it and walks the folder, so a name that lands after that
walk is still news (one landing between the two reads is at worst reported twice). Once a second it stats each folder; a folder whose stamp moved is listed and each name that
differs from what the caller knows becomes a change, so nothing is reported twice by the net and
nothing an event missed stays missing. Names that went away are reported at once. A new name is
reported at once only when its origin is known: it was born under 2 s ago, after the net last
read that folder's names, and its status time is within 50 ms of its birth (a move changes the
status time), or its inode just left another open folder. A name born before that read and missing
from it was somewhere else then, so it was moved in however soon after its birth (a folder made
and moved to the trash within 50 ms looks new by its times alone). Any other new name may have been renamed in from a folder no one has open, whose old path
only the OS watch knows; it is held until the OS watch names it, so the old path's deletion and
the new name land in one batch, or for at most 5 s, after which the root is rescanned (an OS watch
that late has lost track, and only a walk drops the old path). On macOS FSEvents also splits a
rename's two records (consecutive event ids, old path first) across deliveries in either order;
whichever half arrives first waits up to 2 s for the other (a record naming an entry present now
is the new name, its partner one id before; any other is the old path, its partner one id after),
so the old path's deletion and the new name are always in one window; a half whose partner never
comes (a move into or out of the root) is then reported alone. A folder with more than
`max_batch` names is rescanned instead whenever its stamp moves, because one event about it does
not vouch for the rest; the rescan waits while events about it keep arriving, for at most 10 s,
and its new stamp is only taken with the rescan. A change inside a file does not move a
folder's stamp; the net covers what the tree shows. On macOS a kqueue `NOTE_WRITE` handle on each
of the first 64 open folders (descriptors: macOS starts processes with 256) wakes the check as the
kernel changes the folder, at most every 50 ms, so a lone change in an open folder reaches the sink
one debounce (75 ms) after it is made, whatever fseventsd is doing. The daemon's folder fan-out
adds its own 100 ms window before `files.folders_changed`.
Acceptance (real temp dirs, generous timeouts, no sleeps shorter than the
debounce): `reports_a_created_file`, `reports_a_deleted_folder`, `rename_is_delete_plus_create`,
`create_then_delete_in_one_window_reports_nothing`, `many_writes_to_one_file_coalesce`,
`burst_over_max_batch_becomes_rescan`, `excluded_folders_report_nothing`,
`new_subfolder_is_watched` (create `a/`, then write `a/b.txt`, expect it); `promptness.rs`: lone
create, delete and rename in a quiet folder (each within 500 ms), a rename made the moment `start`
returns across 32 watches in one process, and a change in an open folder right after a 20,000-file
burst elsewhere (within 2 s). The watcher tests wait for fseventsd to report a sentinel before each
session, so one test's burst does not delay the next test's events.

### files-index

Crates: `ignore` (`WalkParallel`), `frizbee` if its licence and API fit, otherwise
`fuzzy-matcher` (`SkimMatcherV2`), `rayon`, `files-safe`.

```rust
pub struct PathIndex;
impl PathIndex {
    pub fn build(root: &files_safe::Root, options: &IndexOptions,
                 cancel: &AtomicBool) -> Result<PathIndex, Error>;
    pub fn apply(&mut self, root: &files_safe::Root, changes: &[IndexChange]);
    pub fn search(&self, query: &str, limit: usize) -> Vec<Hit>;
    pub fn len(&self) -> usize;
    pub fn truncated(&self) -> bool;
}
pub struct IndexOptions { pub max_files: usize, pub include_ignored: bool, pub hide: Vec<String> }
pub struct IndexChange { pub path: String, pub deleted: bool, pub directory: bool }
pub struct Hit { pub path: String, pub score: u32, pub positions: Vec<u32> }
```

Behaviour: files only, git-ignore rules respected unless `include_ignored`, `hide` as in
files-list, cap `max_files` (default 1,000,000; past it `truncated()`). Store paths in one arena
(`String` plus `u32` offsets), not a `Vec<String>`. `apply` adds and removes files; a created
directory walks its subtree, a deleted directory drops its subtree. Ranking like VS Code's quick
open: matches in the file name beat matches spread over folders, contiguous runs beat scattered
ones, shorter paths win ties; a query containing `/` matches across segments. `positions` are
byte offsets into `path` for highlighting. Empty query returns nothing. Acceptance:
`finds_file_by_scattered_letters`, `file_name_match_ranks_above_folder_match`,
`slash_query_matches_path_segments`, `respects_gitignore`, `apply_adds_and_removes_files`,
`deleted_folder_drops_its_subtree`, `created_folder_adds_its_subtree`,
`stops_at_max_files_and_reports_truncated`, `cancel_stops_build`. Bench (generated tree of
1,000,000 paths): build time, memory per path, and p50 query time for `srvmain`, `main.rs`,
`crates/ace` (target under 30 ms on an unloaded machine).

### files-search

Crates: `grep-searcher`, `grep-regex`, `grep-matcher`, `ignore` (`WalkParallel`), `globset`,
`files-safe`.

```rust
pub fn search(root: &files_safe::Root, query: &Query, cancel: &AtomicBool,
              sink: &(dyn Fn(FileMatches) -> bool + Sync)) -> Result<Summary, Error>;
pub struct Query { pub pattern: String, pub regex: bool, pub case: Case, pub whole_word: bool,
                   pub include: Vec<String>, pub exclude: Vec<String>, pub include_ignored: bool,
                   pub max_matches: usize, pub max_file_bytes: u64 }
pub enum Case { Sensitive, Insensitive, Smart }
pub struct FileMatches { pub path: String, pub lines: Vec<LineMatch> }
pub struct LineMatch { pub line: u64, pub preview: String, pub ranges: Vec<(u32, u32)> }
pub struct Summary { pub files: u64, pub bytes: u64, pub matches: u64, pub limit_hit: bool }
```

Behaviour: streams one `FileMatches` per file as found; the sink returning `false` stops the
search. Binary files are skipped (quit on NUL). Previews are at most 400 bytes around the match,
lossy UTF-8, `ranges` are byte offsets inside the preview. Invalid regex is `INVALID_ARGUMENT`.
Acceptance: `finds_literal_across_files`, `regex_with_groups`, `smart_case_is_insensitive_for_
lowercase_query`, `whole_word_skips_substrings`, `include_and_exclude_globs`,
`skips_gitignored_unless_asked`, `skips_binary_files`, `stops_at_max_matches_with_limit_hit`,
`sink_false_stops_search`, `long_line_preview_is_bounded`. Bench: literal search over this repo
(`apps/` and `packages/`), report time and bytes.

Confinement: on Linux each file is opened by its checkout path from the root handle in one
`openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`
(`files_safe::Root::open_file_unlinked`), so the open is its own proof: no link followed anywhere,
nothing outside the root reached, and nothing able to move between the proof and the open. Where
that call is unavailable (other platforms, an old kernel, a seccomp filter) each file is opened
through its folder's handle with no link following, then `files_safe::Root::is_at` proves before
any read that its checkout path, resolved the same way, is the open file (macOS `fstatat` with
`AT_SYMLINK_NOFOLLOW_ANY`, a no-link walk from the root elsewhere). Folders open with
`Root::open_dir_unlinked`, and the `.gitignore` files above a nested checkout are read only as
regular files, never through a link. Accepted limits, as for files-io's save:

- A file or a folder above it moved out of the checkout in the instant between that per-file
  proof and the read can be read once: no check made before a read can cover a move after it, and
  main had the same window.
- If the checkout root is renamed and its path replaced by a link to where it went, the search
  reads that same moved checkout through its root handle, never another tree's data.
- Mount points the person makes inside the checkout (bind mounts) are searched, as `rg` and
  VS Code search them: the person put that tree there.
- Bench: `cargo bench -p ace-files --bench search` measures ace end to end next to `rg` on a
  generated 200k-file tree (see the bench's header for its options).

### files-io

Crates: `files-safe`, `cap-std`, `encoding_rs`, `chardetng`, `tempfile`, `content_inspector` (or
the NUL heuristic), `trash` is NOT used (ace keeps its own recently-deleted area, wave 3).

```rust
pub fn read(root: &Root, path: &str, range: ReadRange) -> Result<Read, Error>;
pub fn stat_version(root: &Root, path: &str) -> Result<Option<String>, Error>;
pub fn write(root: &Root, path: &str, bytes: &[u8], expected: Option<&str>) -> Result<String, Error>;
pub fn create_file(root: &Root, path: &str, bytes: &[u8]) -> Result<String, Error>;
pub fn create_dir(root: &Root, path: &str) -> Result<(), Error>;
pub fn rename(root: &Root, from: &str, to: &str, overwrite: bool) -> Result<(), Error>;
pub fn remove(root: &Root, path: &str) -> Result<(), Error>;
pub struct ReadRange { pub offset: u64, pub length: u64, pub max_size: Option<u64> }
pub struct Read { pub size: u64, pub version: String, pub bytes: Vec<u8>, pub binary: bool,
                  pub encoding: &'static str, pub bom: bool, pub eof: bool }
```

Behaviour: `version` must equal the TypeScript daemon's format exactly, so stored drafts keep
working: `"{dev}:{ino}:{size}:{mtimeMs}:{ctimeMs}"` where the times are milliseconds as
JavaScript prints a float (`1731800000123.4567` keeps its fraction; integers print without `.0`).
Read `packages/files/src/types.ts` (`version`) and match it; on Windows use the file index and
volume serial as `dev`/`ino`. `write` with `expected` set compares the current version first and
returns `CONFLICT` if it differs; it writes to a temp file in the same folder, fsyncs, then renames
over, preserving the original mode. `None` for `expected` means create only (`CONFLICT` if it
exists). Detect encoding from the BOM, else UTF-8 if valid, else `chardetng`; report
`binary: true` when the first 8 KiB has a NUL. `max_size`: no bytes if the file is larger.
`rename` never overwrites unless asked. `remove` deletes files and folders (recursive). All
operations go through `files-safe`. Acceptance: `version_matches_javascript_format`,
`write_with_stale_version_conflicts`, `write_is_atomic_on_crash_simulated_by_temp_left_behind`,
`write_keeps_file_mode`, `create_refuses_existing_file`, `reads_a_range`,
`detects_utf16_bom_and_latin1`, `binary_file_is_flagged`, `max_size_returns_no_bytes`,
`rename_refuses_to_overwrite`, `remove_folder_recursively`, `operations_refuse_paths_outside_root`.

A versioned save stages a complete copy, journals the names it will use and the identities of both
entries, and publishes it with one atomic exchange (a move aside and an insert on Windows). A save
interrupted between those steps is resolved when the checkout is next opened: the entry the save
displaced is put back at its name without replacing one, or kept under a visible recovery name, so
the journal is dropped only once nothing of the caller's is hidden.

The guarantees hold against another program replacing, renaming, deleting or creating the path:
those change the directory entry, so the save sees them and preserves the version that left the
name. They do not hold against a second program that holds the same file open and writes in place
at the exact instant of the save. An open handle can write after any check the save makes, and a
write squeezed between the swap and the cleanup of the displaced entry goes into an entry the
cleanup removes. That write can be lost. ace takes no file lock and does not watch in-place writes
during a save, the same limit every editor that saves by rename has; a save is one person's
version replacing another's whole, never a merge of two writers' bytes.

### files-wire

Crates: `serde`, `serde_json`, `thiserror`.

Framing on stdio, both directions: `u32` little-endian length of the rest, one `u8` kind, then
the payload. Kind `1`: a UTF-8 JSON message. Kind `2`: a binary body, `u64` LE request id then the
bytes; it belongs to the JSON message with the same id that says `"body": true`. A frame may
declare at most 16 MiB (`MAX_FRAME_LEN`, kind byte and payload), so a body carries at most
`MAX_BODY_LEN = MAX_FRAME_LEN - 9` bytes, and anything larger is `TOO_LARGE`. Provide
`encode(&Message) -> Result<Vec<u8>, Error>`, `encode_body(id, &[u8]) -> Result<Vec<u8>, Error>`,
and an incremental `Decoder` that takes byte chunks and yields complete frames, never panics on
garbage, and reports oversize frames as errors: the declaration is refused on that call and on
every later one, while `push` drops what still arrives so a dead decoder holds no memory.

Messages (serde, `tag = "type"`, `rename_all = "camelCase"`, unknown fields ignored):

- daemon -> ace-files: `hello { protocol: 1 }`, `request { id, op }`, `cancel { id }`.
- ace-files -> daemon: `hello { protocol: 1, version }`, `response { id, result }`,
  `error { id, code, message, current? }`, `event { subscription, payload }`.
- `op` (`tag = "op"`): `openRoot { path }` -> `{ root }` (a number); `closeRoot { root }`;
  `list { root, dir, limit, cursor?, hide }`; `stat { root, path }`;
  `read { root, path, offset, length, maxSize? }` -> metadata, bytes as a body;
  `write { root, path, expected? }` with a body -> `{ version }`; `createFile`, `createDir`,
  `rename { root, from, to, overwrite }`, `remove { root, path }`;
  `watch { root }` -> `{ subscription }` then `event` payloads `changes { changes }`,
  `rescan { dir? }`, `warning { message }`; `unwatch { subscription }`;
  `indexQuery { root, query, limit }` -> `{ hits, total, truncated, ready }`;
  `search { root, query… }` -> `{ subscription }`, events `matches { file }`, then
  `searchDone { summary }`.

Every nested value is tagged too, so a client reads the shape instead of guessing it. A response's
`result.type` is one of `done` (`closeRoot`, `unwatch`, `createDir`, `rename`, `remove`), `root`
(`openRoot`), `subscription` (`watch`, `search`), `page` (`list`), `entry` (`stat`), `read`,
`version` (`write`, `createFile`) or `index` (`indexQuery`). A `read` result carries
`"body": true` in place of the bytes: the bytes follow in a kind-2 frame with the response's id. An
event payload's `type` is `changes`, `rescan`, `warning`, `matches` or `searchDone`. An entry's
kind is tagged the same way: `{"type":"file"}`, `{"type":"directory"}`, `{"type":"other"}`, and
`{"type":"symlink","target":{"type":"directory"}}`, with `target` left out when the link leaves the
root. Optional fields are left out when absent.

A kind-1 payload that does not parse still yields its request id (`Error::Message { id, source }`,
read back with `Error::id()`), so the daemon answers that request instead of leaking it, and an
`op` tag this build does not know is `UNSUPPORTED` rather than a broken message.

Put one golden vector per message in `native/files/vectors/*.json`. A JSON vector holds `json` (the
message, for reading), `text` (the exact payload that follows the five-byte header) and `frame`
(hex); a body vector holds `{"id", "bytes"}` and its frame. The Rust tests round-trip them and the
TypeScript client (wave 2) tests the same files.
Acceptance: `every_vector_round_trips`, `decoder_handles_split_and_joined_frames`,
`decoder_rejects_oversize_frame`, `unknown_fields_are_ignored`, `unknown_op_is_an_error_value`.

### editor-core (native/editor)

Crates: `ropey`, `regex`, `unicode-segmentation`, `thiserror`. Pure Rust, no wasm-bindgen here
(that's `editor-wasm`, wave 2), builds for `wasm32-unknown-unknown` and native.

```rust
pub struct Document;
impl Document {
    pub fn new(text: &str) -> Document;
    pub fn text(&self) -> String;  pub fn len_lines(&self) -> usize;
    pub fn line(&self, index: usize) -> Cow<'_, str>;
    pub fn apply(&mut self, edit: Transaction) -> Applied;     // returns changed line range
    pub fn undo(&mut self) -> Option<Applied>;  pub fn redo(&mut self) -> Option<Applied>;
    pub fn selections(&self) -> &[Selection];  pub fn set_selections(&mut self, s: Vec<Selection>);
    pub fn find(&self, query: &FindQuery, limit: usize) -> Vec<Range>;
    pub fn version(&self) -> u64;
}
```

Positions are `(line, column)` with column in UTF-16 code units (what the DOM uses), converted
internally. Edits: insert/delete/replace at every selection (multi-cursor), with commands for
typing, newline with indentation carried over, backspace by grapheme, delete word, indent/outdent
lines, move line up/down, duplicate line, toggle line comment (comment token passed in), select
next occurrence, column (box) selection. Undo groups consecutive typing until a pause the caller
signals, a selection jump, or a newline. Line endings: detect `\n` / `\r\n` on load and keep them.
Acceptance: `typing_at_three_cursors_inserts_at_each`, `undo_restores_text_and_selections`,
`typing_run_undoes_as_one_step`, `newline_keeps_indentation`,
`backspace_removes_one_grapheme_cluster` (emoji with modifiers), `utf16_columns_round_trip`,
`move_line_down_keeps_selection`, `toggle_comment_on_mixed_lines`, `crlf_survives_edit`,
`find_regex_and_whole_word`, `select_next_occurrence_adds_cursor`. Bench: 200,000-line file:
load time, 1,000 single-character inserts at random lines, `line()` p50.

### editor-diff (native/editor)

Crates: `imara-diff`. `pub fn line_marks(original: &str, current: &str) -> Vec<Mark>` with
`Mark { line: u32, kind: Added | Modified | Removed }`, matching what
`packages/ui-core` `LineMark` means today (read its source). Acceptance: `added_lines`,
`removed_lines_mark_the_line_below`, `modified_block`, `identical_text_has_no_marks`. Bench:
200,000-line file with 100 scattered edits under 20 ms.

## markit

In the markit repository (`arpan404/markit`), add a line-level incremental highlighter beside
`highlight(code, language)`: a `LineHighlighter` that holds per-line boundaries and runs (the
existing `Boundary`/`ParsedLine` logic, reused, not copied), with
`new(language)`, `set_text(text)`, `edit(start_line, removed_lines, inserted: &[&str])`, and
`tokens(start_line, end_line) -> Vec<Vec<CodeToken>>` that parses lazily up to `end_line` and
stops re-parsing once a line's boundary matches the cached one. Same colours and tokens as
`highlight` for the same text (test that on the existing fixtures). Expose it through
`markit-wasm` and `markit-ffi` (Swift, Kotlin) in the same shape.

## Wave 2 contracts

### Line model (settled for the editor, markit and editor-core)

Lines split on `\n` only. A `\r` right before `\n` belongs to the line ending; a lone `\r` is
not a separator. `"a\n"` is two lines, the last one empty. Columns are UTF-16 code units.

### packages/files-native (daemon side)

A TypeScript package owning the `ace-files` process for the daemon, modelled on
`packages/media` (`media-binary.ts`, `supervisor.ts`); read those first and follow their shape.

- `filesBinaryName(platform)` and a binary lookup with the same release/development modes as
  `mediaBinaryName` (development: `ACE_FILES_PATH`, then `native/files/target/release/ace-files`,
  then the debug build).
- `FilesProcess`: spawns the binary with stdio pipes, sends `hello`, checks `protocol: 1`, and
  restarts it with backoff (250 ms doubling to 10 s, reset after 60 s healthy) when it exits.
  While it is down, requests fail at once with code `FILES_RESTARTING` (retryable); nothing
  queues without bound. Every request has a timeout (default 30 s) and an `AbortSignal` that
  sends `cancel`. Roots and watch subscriptions are re-opened after a restart, transparently to
  callers.
- `FilesClient`: typed methods for every op in the files-wire section (`openRoot`, `list`,
  `stat`, `read` returning bytes from the body frame, `write`/`createFile` sending a body,
  `rename`, `remove`, `watch` returning an async-disposable subscription with an `onBatch`
  callback, `indexQuery`, `search` streaming matches). Decoding is Zod schemas in this package
  mirroring files-wire exactly; a frame decoder in TypeScript with the same limits and
  dead-decoder rule as the Rust one.
- Tests: the codec round-trips every file in `native/files/vectors/` byte for byte (the
  `text` and `frame` fields); supervisor behaviour against a small fake binary written as a Bun
  script speaking the same frames (restart with backoff, `FILES_RESTARTING` while down,
  timeout, cancel, re-open after restart, oversize frame kills and restarts the process).
  The real-binary test comes with the `ace-files` crate.

### Client protocol (packages/protocol)

Additive; the old `list` stays for shipped clients.

- `FileOperation` gains `{ op: "list.folder", path, limit (1..=5000, default 500), cursor? }`
  returning `{ entries: FolderEntry[], nextCursor: string | null, total: number }` with
  `FolderEntry = { name, path, kind: "file" | "directory" | "symlink" | "other",
target?: "file" | "directory" | "other", size, mtimeMs, ignored }`. `INVALID_CURSOR` tells the
  client to list the folder again from the start.
- Client message `files.watch { threadId, folders: string[] }` (at most 512 folders; each call
  replaces that client's previous set for the thread; `[]` stops watching). The daemon pushes
  `files.folders_changed { threadId, folders: string[], rescan: boolean }`, coalesced to at most
  one message per 100 ms per client, naming only folders in that client's set (a change inside
  `a/b/` names `a/b`; `rescan: true` means re-list every watched folder). Clients re-list just
  those folders. This keeps a 3G link quiet: no per-file payloads.
- Quick open keeps its current request shape; the daemon answers it from `indexQuery`.

## Waves and branches

- Integration branch: `ace/rust-files` on origin. Each builder branches from it in its own
  worktree and pushes `ace/rust-files-<crate>`. The orchestrator reviews and merges.
- Wave 1 (parallel): files-safe, files-list, files-watch, files-index, files-search, files-io,
  files-wire, editor-core, editor-diff, markit line highlighter. `files-safe` already exists on
  the integration branch with the API above and a simple body; the files-safe builder hardens it
  (cap-std resolution, Windows rules, tests) without changing its signatures. Other crates use it
  as a path dependency, `files-safe = { path = "../files-safe" }`.
- Wave 2: `ace-files` binary; `packages/files-native` supervisor and client; protocol ops
  (`list` per folder, `watch`, `indexQuery`, `search`) in `packages/protocol`; daemon wiring;
  file tree rewrite (lazy folders, live updates); `editor-wasm` and `packages/editor`; editor
  view in the Files tab; iOS bridge; release staging (`stageAceFiles`, desktop build, verify).
- Wave 3:
  - Reads and writes cut over to ace-files (files-io through the daemon), with recently-deleted,
    uploads and archives; then delete the TypeScript list, watch, search and path-index code.
  - Windows watching: notify ignores ReadDirectoryChangesW overflow and ERROR_NOTIFY_ENUM_DIR, so a
    small Windows backend that turns them into `Rescan`, tested in the Windows VM; Linux runs on a
    real machine.
  - Word wrap in the editor (variable row heights in the virtual list).
  - Benches on a 1,000,000-file checkout: tree open, quick open, search, watcher bursts.
