# Project picker backend

Use the selected machine's `pool.projects(hostId)` or `pool.client(hostId).projects`.
Single-daemon clients use `client.projects`. Offline machines keep the client's normal
request error behavior; calls never fall back to another machine. The same JSON requests
travel over direct, remote and encrypted relay connections. No filesystem work runs in the client.

Every operation below uses this envelope and requires `projects` scope:

```ts
{ type: "projects.request", requestId: string, operation: Operation }
{ type: "projects.result", requestId: string, result: Result }
```

`requestId` is 1 to 128 characters. Helpers accept the existing `RequestOptions`, including
`signal`, `timeoutMs` and `requestId`. They return the whole `ProjectsResult` envelope.
Errors return `{ kind: "error", code: string }`. In particular, expect `forbidden`,
`outside_project_roots`, `invalid_path`, `directory_unavailable`, `directory_too_large`,
`search_cancelled`, `busy` or `git_invalid_argument`.

```ts
client.projects.search({ query, limit?, showHidden? }, options?)
// operation: { op: "fs.search", query: string, limit: 30, showHidden: false }
// result: { kind: "search", query: string, entries: FolderMatch[],
//           indexing: boolean, truncated: boolean }

client.projects.complete({ path, limit?, showHidden? }, options?)
// operation: { op: "fs.complete", path: string, limit: 50, showHidden: false }
// result: { kind: "completion", path: string,
//           candidates: (FolderMatch & { completion: string })[],
//           commonPrefix: string, truncated: boolean }

client.projects.validateCloneUrl(url, options?)
// operation: { op: "workspace.clone.validate", url: string }
// result: { kind: "cloneUrl", url: string, name: string }

interface FolderMatch {
  name: string;
  path: string; // Canonical absolute host path, for inspect/add/create/clone parent.
  isGitRepo: boolean; // Directory or file .git marker, including worktrees.
  isProject: boolean;
  lastOpened?: number; // Persisted registration/open timestamp, milliseconds.
  recentScore: number; // 1 / recency rank, or 0 for folders outside the top 100 recents.
  score: number; // Search relevance plus recency; descending, then path tie-break.
}
```

`query` is at most 256 characters. Paths and URLs are at most 4,096 characters.
Limits are integers from 1 to 100. `showHidden` defaults to false. Exact names rank first,
then prefixes, substrings, fuzzy names and fuzzy root-relative paths. The score ranges do not overlap, including recency bonuses. Recent folders add
up to 50 ranking points. An empty query puts recent folders first. The existing
`fs.recentFolders` response stays compatible and its recent catalog feeds search.
The top 100 recents can appear below the traversal depth limit. Ignored descendants
remain excluded, including recent projects inside ignored directories.

Search returns one bounded response. `indexing: true` means a lazy scan has more work;
repeat the latest query to continue it. `truncated` also covers depth, size, inaccessible
folders and response limits, so it can remain true after indexing finishes. A new search
or completion aborts the previous picker request on that socket, returning
`search_cancelled`. Different connections, even from the same device, have independent
cancellation. Socket closure cancels its active picker work. Local `RequestOptions.signal`
cancels client waiting; send a replacement picker request to supersede host work.

The in-memory BFS index admits at most 32 canonical roots, 1,024 directories per root,
four levels below each root and 128 scan steps per root per call. Each enumeration slice
examines at most 256 names and yields between directory opens. A suspended directory retains one enumeration of at most 10,000 names per root view, rather than reading and sorting the directory again for every slice. Its device/inode identity is checked before reusing that snapshot. Search uses a cooperative
35 ms scan budget; completion uses 50 ms and at most 256 metadata lookups for matching entries, including files and rejected links. OS calls
and result validation can exceed that budget on slow filesystems. No recursive background
scan, whole-disk traversal or persistent index runs. Indexes refresh lazily after 30 seconds
are discarded when roots change, and keep separate hidden-mode views within 32 total cache slots. Directory name enumeration has the
existing descriptor boundary's 10,000-name limit. Disappearing entries are skipped individually. Transient directory failures retain the queued scan for another request. Warm search validates at most limit + 128 ranked candidates, fills the page past rejected cached hits and checks one additional live match to report truncation. Stale index entries are evicted; a validation cap leaves truncation true when remaining matches are unknown. Roots are resolved once per request and rechecked before delivery, so deleted folders and escaping replacements disappear immediately.

Search never follows directory symlinks. Completion may offer a symlink whose canonical
target remains allowed and passes the ignored-directory policy; its insertion text preserves the typed alias. Both check realpath
containment, system-directory policy and pinned directory identity. Home is the default
root when no roots are configured. Explicit roots can exclude home, and `~` cannot bypass
them. `node_modules`, `.git` internals, caches, `Library`, build outputs, `vendor`, ace data
and dot directories are skipped. Explicit hidden mode still excludes ignored directories.

Completion accepts absolute paths and the current user's `~` or `~/` prefix. It preserves
spaces and punctuation, matches prefixes literally and case-sensitively, and inserts a
trailing host separator. `~/Co` may return `~/Code/`. The common prefix covers every
validated match, including candidates omitted by the response limit. If scan bounds stop
validation before all matches are known, `commonPrefix` remains the input. An exhaustive
scan with no matches returns an empty prefix. Relative paths, other-user tildes, traversal
and NUL are refused across the entire expanded input, including its final segment. Literal backslashes in POSIX names are preserved. Typing a trailing separator completes children of that directory.

Clone validation accepts credential-free HTTPS, SSH, scp-style `git@host:path` and GitHub
`owner/repo` shorthand. Shorthand becomes `https://github.com/owner/repo.git`; the suggested
name is the decoded final repository component with `.git` removed. Passwords, HTTPS
usernames, query strings, fragments, controls and invalid destination names are refused.
Validation never contacts the network. `projects.clone` also accepts shorthand directly.
Use the returned `url` and `name` with the existing clone command. Existing
`projects.onCloneProgress` emits `starting`, `receiving`, `resolving`, `checkout`,
`completed`, `cancelled` and `failed`, with optional integer `percent` and `commandId`.
Existing `projects.cancelClone(commandId)` remains device-owned.
