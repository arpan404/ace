# Windows workspace backend — safe design (research)

Status: the production Windows binding, private file consumers and normal install pass MSVC compilation and 29 files / 179 tests on both architectures in [run 40006284111](https://github.com/arpan404/ace/actions/runs/40006284111), pinned to `97945b24b`. The public daemon API clean-start/restart baseline also passes. Private directory creation and data-home ACL enforcement remain in progress; confined Git startup and complete installed-app acceptance remain required.

## 1. Consumers pin numeric fds; HANDLE-only is rejected

These call sites take numeric fds and cannot take raw `HANDLE`s without a rewrite: `Descriptor` (`fstat`/`read`/`write`/`close` on `this.fd`, `workspace/src/descriptor.ts`), `new Socket({ fd })` plus `closeSync` (`input-pipe.ts`), `stdio: [...pipes.map((p) => p.fd)]` (`process.ts`), `stdio: [..., fd]` (`git/src/pinned-process.ts`), and `fstatSync(fd).isFIFO()` on inherited pipe fds (`pipe-transport.process.test.ts`). A backend exporting only `HANDLE`s breaks all of them. The backend therefore exports CRT fds valid in Node fs and child stdio.

## 2. Descriptor interop: the libuv fd bridge (normative)

Use the libuv helpers Node already ships instead of exporting private CRT fds or rewriting consumers: [uv_get_osfhandle](https://docs.libuv.org/en/v1.x/fs.html#c.uv_get_osfhandle) (CRT fd to OS `HANDLE`; still CRT-owned — never close it, never use it after the fd closes) and [uv_open_osfhandle](https://docs.libuv.org/en/v1.x/fs.html#c.uv_open_osfhandle) (OS `HANDLE` to CRT fd — consumes the argument; never `CloseHandle` after the call). They wrap [_get_osfhandle](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/get-osfhandle) and [_open_osfhandle](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/open-osfhandle); the latter transfers `HANDLE` ownership to the fd, which closes with `_close` (what libuv `fs__close` already does). Declarations are in the installed libuv header (`UV_EXTERN uv_os_fd_t uv_get_osfhandle(int fd);`, `UV_EXTERN int uv_open_osfhandle(uv_os_fd_t os_fd);`, new in libuv 1.12.0 / 1.23.0) and in the full Node headers shipped for addons.

Runtime ownership is normative: build the addon with [/MD](https://learn.microsoft.com/en-us/cpp/build/reference/md-mt-ld-use-run-time-library), use full matching Node headers and link [node.lib](https://nodejs.org/api/addons.html). This does **not** make the addon's CRT descriptor table match Node's. [Node 24.13.0's build configuration](https://github.com/nodejs/node/blob/v24.13.0/common.gypi) defaults to a static CRT for its executable. A direct addon `_close(fd)` caused a native fast-fail in the directory creation fixture. Owned fd cleanup therefore uses Node's synchronous [uv_fs_close](https://docs.libuv.org/en/v1.x/fs.html#c.uv_fs_close), followed by `uv_fs_req_cleanup`; allocation uses `uv_open_osfhandle`, validation uses `uv_fs_fstat`, and borrowing uses `uv_get_osfhandle`. No addon CRT fd operation or invalid-parameter handler is a substitute.

Ownership: successful `uv_open_osfhandle(h)` transfers the handle into Node's runtime. TS uses Node `close` / `read` / `write` / `fstat` / `fsync`. Temporary or error-path fd cleanup also goes through Node's libuv. Borrowed handles are never closed or retained past the synchronous call. NAPI carries numeric fds only.

## 3. Handle core: `NtCreateFile` + `RootDirectory` (normative)

All opens use user-mode [NtCreateFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile) with [OBJECT_ATTRIBUTES.RootDirectory](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/object-attributes) set to the parent directory handle and `ObjectName` set to exactly one component (`RootDirectory` resolves a relative `ObjectName` inside the supplied directory object — documented user-mode-callable NT semantics).

- `openRoot(volumePath)`: parse the volume prefix (`C:\`, UNC `\\server\share\`; reject `\\?\` caller inputs), open the volume root, walk each component with `NtCreateFile(RootDirectory=parent, FILE_OPEN, FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT, SYNCHRONIZE)`, asserting directory plus not `FILE_ATTRIBUTE_REPARSE_POINT` per step and capturing `FileIdInfo`. Never accept `.`, `..`, `/`, `\`, `:`, `? * < > |`, NUL/1..31, trailing space/dot, reserved `CON PRN AUX NUL COM1-9 LPT1-9`, ADS colon, or case-variant `..`. Rules: [naming a file](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file); tags (`SYMLINK 0xA000000C`, `MOUNT_POINT 0xA0000003`, cloud / AppExecLink / WSL): [reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points), [MS-FSCC](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/c8e77b37-3909-4fe6-a4ea-2b9d423b1ee4).
- `openAt(parentFd, name, kind)`: same single-component validator; `RootDirectory = uv_get_osfhandle(parentFd)`; `FILE_OPEN` (+ `FILE_CREATE` only for exclusive create); `FILE_OPEN_REPARSE_POINT` always; access `GENERIC_READ` (read/dir), `FILE_READ_ATTRIBUTES|SYNCHRONIZE` (metadata), `GENERIC_READ|GENERIC_WRITE|DELETE` as needed. Query identity (§5) immediately; non-metadata opens fail closed on reparse points. Directory opens follow the [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) `FILE_FLAG_BACKUP_SEMANTICS` + `FILE_FLAG_OPEN_REPARSE_POINT` pattern.
- Every returned `HANDLE` is converted with `uv_open_osfhandle` before crossing napi, so napi carries only CRT fds. Any reparse point is an escape unless the op explicitly opens the link itself.

## 4. Handle-relative ops (normative, no path joins)

Each op borrows the parent `HANDLE` via `uv_get_osfhandle(parentFd)`; the fd must stay open for the call.

- `statAt`: `FileIdInfo` + `FileBasicInfo` + `FileStandardInfo` + `FileAttributeTagInfo` on a metadata-access `OPEN_REPARSE_POINT` handle. Synthesize `S_IFREG`/`S_IFDIR`/`S_IFLNK`; any reparse point reports `symlink`, callers deny. ([GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandleex), [FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info), [FILE_ATTRIBUTE_TAG_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_attribute_tag_info).)
- `names`: `FileIdExtdDirectoryRestartInfo` followed by `FileIdExtdDirectoryInfo` batches on the pinned directory handle until `ERROR_NO_MORE_FILES`; skip `.`/`..`; invalid cap is `EINVAL`, accepted entries beyond cap are `E2BIG`. ([FILE_ID_EXTD_DIR_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_extd_dir_info).)
- `mkdirAt`: `NtCreateFile(RootDirectory=parent, FILE_CREATE, FILE_DIRECTORY_FILE)`.
- Same-parent rename uses `NtSetInformationFile(FileRenameInformation=10)` with the rename record's `RootDirectory=parent` and one validated component. `renameExclusiveAt` sets `ReplaceIfExists=FALSE`; `renameAt` uses `TRUE` for replacing publication. The first x64 fixtures rejected the equivalent `SetFileInformationByHandle` call; the native-call correction passed the same fixtures on x64 and ARM64 in run 39878029237. No absolute-path fallback is allowed. ([NtSetInformationFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile), [FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information).)
- `unlinkAt` / `removeDirectoryAt`: open child `OPEN_REPARSE_POINT` with `DELETE`, then `FileDispositionInfo{DeleteFile=TRUE}`; deletes the link itself, never follows; junction removal keeps the target. ([FILE_DISPOSITION_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info).)
- Staging fence: `FlushFileBuffers` on the data handle before publish; directory flush is best-effort, not part of the guarantee. ([FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).)

## 5. Identity: `FileIdInfo` strings; never Node Stats `dev:ino`

libuv on Windows fills [`uv_stat_t`](https://docs.libuv.org/en/v1.x/fs.html#data-types) lossily ([src/win/fs.c](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c)): `st_dev` is only `VolumeSerialNumber.LowPart` (32 bits), `st_ino` is the 64-bit `IndexNumber` rather than the 128-bit `FILE_ID_INFO.FileId`, and pipes get `st_ino = (uintptr_t) handle`. Node [Stats](https://nodejs.org/api/fs.html#class-fsstats) surfaces these as JS doubles, exact only to 2^53. Comparing native identity against Stats `dev:ino` doubles therefore silently aliases (ReFS, where the 64-bit index is not unique, is the sharp case).

`ef16a3188` carries a discriminated identity through production POSIX descriptor,
path and metadata observations. POSIX device/inode values are decimal strings
from the same bigint stat observation; native `statAt` also returns exact strings.
`sameFile` compares those identities, while numeric `Stats` fields remain display
metadata and serialize without bigint fields. Four precision/serialization tests
and 23 existing confinement/file/runtime tests pass.

The schema also accepts Windows identities as `{kind: "win32", vol, id}`, with
16 hex digits for the volume and 32 for the file ID. Windows observations still
need mapping from native `FileIdInfo`, including descriptor, path and metadata
proofs. `Descriptor.stat()` and the runtime's path stat functions explicitly
reject Windows until that mapping exists. Bigint Node `dev/ino` values cannot
substitute for the native Windows identity. Backend loading and build activation
remain separate gates.

## 6. Search input: POSIX fd batches and Windows stdin

POSIX search retains its numeric `{read, write}` pipes and `/dev/fd/N` arguments.
Windows search sends each file's already-confined byte stream to ripgrep stdin
with `-- -`, then maps ripgrep's `<stdin>` JSON path to the logical workspace
path. No workspace pathname or temporary data file is passed to ripgrep.
`command()` streams an `AsyncIterable<Buffer>` with pipeline backpressure,
propagates producer errors and reaps the child on cancellation or limits.
The search owner still closes the pinned source in its existing `finally` block.
The injected runtime platform selects this transport; Windows drains one file
at a time so it does not hold a batch of 64 descriptors for sequential spawns.

This chooses confinement and straightforward cleanup over spawn efficiency.
On macOS ARM64, the bounded benchmark measured medians of 13 ms for 64 tiny
files via fd batching and 219 ms via stdin per file; four 256 KiB files measured
5 ms versus 14 ms. These host observations are not Windows performance evidence.
Run `node packages/workspace/bench/ripgrep-input.ts` to reproduce. In native run
39880850603, Windows stdin measured 573 ms on x64 and 768 ms on ARM64 for
64 small files, and 39/52 ms respectively for four 256 KiB files. These are
transport microbenchmarks, not installed-app performance acceptance. Named-pipe batching remains a possible
optimization requiring its own ACL, cancellation and performance evidence.
Windows workspace search no longer depends on a native numeric-pipe export.

Primary interfaces: [Node child stdio](https://nodejs.org/api/child_process.html#optionsstdio),
[stream pipeline](https://nodejs.org/api/stream.html#streampipelinesource-transforms-destination-options),
and [ripgrep guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md).

## 7. Real ACL private-file invariants

No `uid 0` bypass exists on Windows; ownership is owner-SID equality, never a well-known-admin shortcut. `chmodMetadata` is deleted from the Windows binding (a no-op success fakes permissions). Instead `checkPrivateAt(parentFd, name)` (`GetSecurityInfo(OWNER|DACL)`; owner SID `EqualSid` against the current token user via `GetTokenInformation(TokenUser)`; DACL `PROTECTED_DACL`, exactly one allow ACE for the owner, no inherited or other-user ACEs; `FileStandardInfo.NumberOfLinks === 1`; regular file only) and `securePrivateAt(parentFd, name)` (`SetSecurityInfo(PROTECTED_DACL_SECURITY_INFORMATION)` installing the owner-only DACL; fails closed — caller retries or reports `PERMISSION_DENIED`, never silent success). ([GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo), [SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo), [EqualSid](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-equalsid), [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation), [DACLs and ACEs](https://learn.microsoft.com/en-us/windows/win32/secauthz/dacls-and-aces).)

The native name-based check/set operations pass Windows fixtures. `76253a305`
adds `checkPrivateFd(fd)`, applying the same shape, owner and DACL checks to the
borrowed handle without reopening its name or closing it. Its fixtures replace
the name in both directions and read the held descriptor afterward. Native x64 and ARM64 each pass all ten private-file tests in
[run 39913429652](https://github.com/arpan404/ace/actions/runs/39913429652).

Production `readBytes(owner)` and `privateFileMetadata` must use the descriptor
that supplies their bytes and metadata. They are not wired to the Windows ACL
checker yet. A successful name-based check alone does not prove a separately
opened descriptor is private.

`32cdaa2e5` adds `createPrivateFileAt`, with the shared SID/ACL builders from
`9593219a5`. It installs a protected owner-only security descriptor in
`OBJECT_ATTRIBUTES.SecurityDescriptor` during exclusive `NtCreateFile`, then
checks the returned data descriptor before returning it. The owner is the current
TokenUser SID, with exactly one zero-flag owner allow ACE. Four new fixtures cover
public inheritance, collisions without ACL repair, replaced ancestors and invalid
names/descriptors. Source checks pass and the fixtures skip on macOS.
[Run 39986601606](https://github.com/arpan404/ace/actions/runs/39986601606), pinned
to `3f2e415b4`, passes MSVC compilation and 19 files / 150 tests on each native
architecture, including all four private-creation cases.

Generic `createFileAt` still uses inherited security. Production private writers
must select the private operation, then use that verified descriptor. Creating a
public file and tightening its DACL later permits another process to open it first.
See [NtCreateFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile)
and [protected descriptor control](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-setsecuritydescriptorcontrol).
Existing generic read/write access also omits `WRITE_DAC`; a setter cannot assume
that a data descriptor grants permission to change the DACL. See Microsoft's
[file security and access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)
and [GetSecurityInfo access requirement](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo).

`42c4f2ad6` introduced an explicit Windows stat source for `Descriptor`.
`84859b865` changes it to `windowsDescriptorStats(statFd)`: native volume/file-ID
strings and reparse-aware mode accompany Node bigint display metadata from the
same held fd. Node's `fstat` reports an opened junction as a directory, so native
mode also owns the type predicates. Async parse failures reject the observation;
the caller keeps the fd open through it. JSON serialization remains numeric.

`8b98a871e` adds `openMetadataAt`, requesting only `FILE_READ_ATTRIBUTES` and
`SYNCHRONIZE`, without data or ACL modification access. `statFd` and `statAt`
share the same native handle query. [Run 39994964122](https://github.com/arpan404/ace/actions/runs/39994964122),
pinned to `84859b865`, passes MSVC compilation and 21 files / 158 tests on each
native architecture. The fixtures verify metadata-only access, link identity,
traversal refusal and pinned parent/leaf replacement. All 24 host regressions pass.

`c0469a9a2` adds an explicit Windows filesystem adapter with separate `stat`
target-following and `lstat` leaf-observation behavior. It closes the pinned
handles after each observation; expected-versus-anchored confinement checks
remain required. All four cases pass on native x64 and ARM64 in [run 39996443611](https://github.com/arpan404/ace/actions/runs/39996443611), pinned to `c0469a9a2`: MSVC compilation and 22 files / 162 tests per architecture.
That adapter slice kept the default bindings POSIX-only. `11859cd89` now selects the Windows binding and path adapter on Windows.

## 8. Error mapping

`ERROR_FILE_NOT_FOUND(2)` / `ERROR_PATH_NOT_FOUND(3)` to `ENOENT`; `ERROR_FILE_EXISTS(80)` / `ERROR_ALREADY_EXISTS(183)` to `EEXIST` (exclusive `CONFLICT`); `ERROR_ACCESS_DENIED(5)` / `ERROR_SHARING_VIOLATION(32)` to `EACCES`; `ERROR_DIRECTORY(267)` to `ENOTDIR`; reparse escape to `ELOOP`; `ERROR_INVALID_NAME(123)` / bad component to `EINVAL`; cap to `E2BIG`; identity mismatch to `ESTALE`; cross-volume to `EXDEV` (no copy fallback). Codes: [system error codes](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes). AV/indexer `SHARING_VIOLATION` gets bounded retries, never infinite; cloud / AppExecLink / WSL placeholders denied by default; same-volume rename durability is NTFS journaling recovery, not a documented old-or-new-bytes proof; `MOVEFILE_WRITE_THROUGH`-equivalent flush covers only the staged data handle. The existing win32 `MoveFileExW` worker branch stays for absolute-path exclusive moves only: [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

## 9. Rejected alternatives

`GetFinalPathNameByHandle` + child join plus parent recheck: ancestor ABA between join and open acts before detection — rejected. `DeleteFileW` / `RemoveDirectory` / `MoveFileExW` path joins for descriptor ops: same TOCTOU — rejected. HANDLE-only backend: breaks every §1 numeric-fd consumer — rejected (§2 bridges instead). Addon-CRT fd operations, including direct `_close`, `_pipe`, or `_open_osfhandle`: cross-runtime invalidation — rejected (§2 uses Node libuv). `chmodMetadata` no-op success: fakes permissions — rejected (§7 uses real DACLs). 128-bit `FileId` in JS doubles: precision loss / ReFS aliasing — rejected (§5 strings). Reparse tag-allowlist: over-broad class, deny-all unless link-itself — rejected. koffi-per-call paths for pinned ops: cannot pin handles — rejected (native addon only).

## 10. Smallest native core task interface

```c
// napi carries only ints (Node-owned fds) and strings. HANDLEs never
// cross napi; each call borrows via uv_get_osfhandle(fd) and stores nothing.
int openRoot(const char* volumePath);                 // walk -> uv_open_osfhandle -> fd
int openAt(int parentFd, const char* name, int kind); // RootDirectory open -> fd
int openMetadataAt(int parentFd, const char* name);   // attributes-only, link-itself -> fd
void mkdirAt(int parentFd, const char* name);
void renameAt(int parentFd, const char* from, const char* to);
void renameExclusiveAt(int parentFd, const char* from, const char* to);
void unlinkAt(int parentFd, const char* name);
void removeDirectoryAt(int parentFd, const char* name);
Stat statAt(int parentFd, const char* name);          // {vol,id,size,mtimeMs,attrs} strings
Stat statFd(int fd);                                 // same metadata, borrowed HANDLE
Names names(int dirFd, int cap);                      // at most 10000, no . / ..
// Windows search uses standard child stdin; POSIX alone exports pipe().
Ident identityOf(int fd);                             // FileIdInfo over borrowed HANDLE
void checkPrivateAt(int parentFd, const char* name);  // §7, fails closed
void checkPrivateFd(int fd);                         // same opened object, borrowed
void securePrivateAt(int parentFd, const char* name); // §7, fails closed
int createPrivateFileAt(int parentFd, const char* name); // creation-time owner/DACL
```

No public native `close`: ordinary fd lifetime stays with TS `Descriptor` via Node `close`. Native temporary/error cleanup uses Node's `uv_fs_close`. No native read/write: Node fs operates on the bridged fds directly.

## 11. Unresolved contracts (verify on a Windows host; not normative)

- U1: `node.lib` on win-x64 and win-arm64 exports `uv_open_osfhandle` / `uv_get_osfhandle` for addon linkage; the link check is the first gate.
- U2: `NtCreateFile` handles are accepted by `uv_open_osfhandle`. Data descriptors support Node `read` / `write`; metadata-only descriptors support `fstat` / `close` while refusing content access. Reparse type comes from native `statFd`, not Node `fstat`.
- U3: the `uv_get_osfhandle(fd)` borrowed `HANDLE` is valid for `NtCreateFile(RootDirectory=...)`, `SetFileInformationByHandle`, `GetFileInformationByHandleEx`, and `GetSecurityInfo` while the fd is open.
- U4: Windows search uses stdin and needs no numeric pipe bridge. Extra fd-based inputs remain POSIX-only; audit any new callers before exposing them on Windows.
- U5: ReFS behavior of the 64-bit index; until measured, §5 assumes it is unsafe and uses only 128-bit string identity.
- U6: AV/indexer retry bounds, OneDrive-placeholder denial fallout, `MAX_PATH` vs long-path opt-in per builder, power-loss durability limits.

## 12. Open risks

Native x64 and ARM64 runs verify the read, metadata and exclusive-creation subset, including the libuv fd bridge. Run 39876189647 also verifies handle-relative deletion on both architectures. The remaining U1–U6 contracts require operation-specific evidence. Integration requires real win-x64 AND win-arm64 hosts at merge, Electron `daemon/descriptor.node` staging check, and `docs/verification/windows-workspace-checklist.md`. No merge with either arch red.

## Production selection and build prerequisites

`c6f692419` keeps POSIX and Windows schemas separate while sharing the lazy addon
loader. `566492794` adds a metadata-only private-file open with `READ_CONTROL`
and `WRITE_DAC`, plus DACL repair on the same held descriptor. Four fixtures
prove replacement cannot redirect repair, hardlink refusal leaves the broad ACL
unchanged, metadata handles cannot read data, and unsafe names/types are refused.
All four execute and pass in run 39999625209 on native x64 and ARM64.

`89c2989f8` connects `build.ts` to the existing Windows compiler. Run the normal
install under a matching MSVC Developer Prompt with native Node 24+ and these
explicit inputs:

- `ACE_WINDOWS_HEADERS_DIR`: the matching full Node include directory containing
  `node_api.h` and `uv.h`.
- `ACE_WINDOWS_NODE_LIB`: the matching architecture/version's `node.lib`.
- `ACE_WINDOWS_CL`: optional explicit `cl.exe`; otherwise the developer prompt's
  `cl` is used.

The compiler writes production `dist/descriptor.node`. It downloads no tools and
refuses missing inputs. CI reuses its SHA-256-verified official Node headers and
library. `cd62df05f` replaces dependency staging with a real frozen install that
runs postinstall; a passed native run is still required before recording W06.

`11859cd89` selects typed native directory/file/private opens, lossless metadata,
listing and mutations. Private reads check the held file's SID/DACL rather than
Windows numeric uid/mode. Upload metadata repair obtains the required rights
before handing its descriptor to the caller. Publication flushes staged data
before rename and keeps the POSIX directory fence on POSIX only, under the
Windows durability limits in section 3. Four new native integration cases cover
default workspace read/list/search/confinement, private publication and held-file
repair. Host confinement/list/read/search/publication checks pass 35 cases; the
Windows integration cases skip on macOS and await the linked native run.

Absolute upload writers and confined Git startup still need their Windows
integration. This selection does not establish complete local daemon or installed
app readiness.

## Native clean-start evidence

Run 40006284111 passes a real frozen install and 29 files / 179 tests on native
x64 and ARM64. The daemon's public status endpoint reports `running` and `ready`
after cold boot and again after a clean restart, with its workspace, host identity
and token preserved. The test substitutes provider discovery; it runs no real
provider session. SQLite WAL rows/locking/persistence, private plugin markers,
private skill evidence and readonly upload repair also execute and pass.

The confined-Git prerequisites are narrower than a completed launcher. A volume
GUID cwd works for Node and Git across an owned scratch drive alias remap. A
metadata-only `FILE_READ_ATTRIBUTES` handle did not deny rename on either host;
requesting directory read access established the expected sharing denial. The
production path still needs the full ancestor lease and process-lifetime owner.

`1f6abef61` shares strict SID/protected-DACL checks and the directory inheritance
ACE builder without changing file rejection rules. `c75b3c1da` shares protected
security-descriptor construction for exclusive creation. The new private-directory
API is under verification. It creates a protected current-user-owned directory
atomically and observes existing directory security through a same-object handle.
It provides no directory ACL setter that could propagate changes through an
existing tree. Data-home integration remains a separate gate.

## Cwd lease reparse gap

`CreateFileW` sharing flags do not constrain attribute-only access. The
`FSCTL_SET_REPARSE_POINT` access check accepts either `FILE_WRITE_DATA` or
`FILE_WRITE_ATTRIBUTES`; it refuses directories whose entry list is nonempty.
These are documented contracts, not native observations in this branch.
Sources: [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[MS-FSA reparse operation](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4aeefef8-92c3-4abc-af7a-a610caf8a165).

Inference: a read lease denying delete/write sharing may still allow an empty
cwd to become a junction through an attribute-only handle. Such an in-place
change may preserve its file ID. The existing rename and GUID-path tests do not
establish protection against that operation. Pinning a checkout's existing `.git`
entry could keep the directory nonempty, but `init` and `clone` legitimately start
before that entry exists. A native empty-directory versus pinned-entry reparse
probe remains required before choosing the confined Git launcher.
