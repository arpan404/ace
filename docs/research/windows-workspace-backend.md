# Windows workspace backend — safe design (research)

Status: independent native addon implements pinned reads, identity, metadata and enumeration. Native MSVC/Windows CI verification is in progress. Production descriptor integration, mutations and ACL enforcement remain unfinished.

## 1. Consumers pin numeric fds; HANDLE-only is rejected

These call sites take numeric fds and cannot take raw `HANDLE`s without a rewrite: `Descriptor` (`fstat`/`read`/`write`/`close` on `this.fd`, `workspace/src/descriptor.ts`), `new Socket({ fd })` plus `closeSync` (`input-pipe.ts`), `stdio: [...pipes.map((p) => p.fd)]` (`process.ts`), `stdio: [..., fd]` (`git/src/pinned-process.ts`), and `fstatSync(fd).isFIFO()` on inherited pipe fds (`pipe-transport.process.test.ts`). A backend exporting only `HANDLE`s breaks all of them. The backend therefore exports CRT fds valid in Node fs and child stdio.

## 2. Descriptor interop: the libuv fd bridge (normative)

Use the libuv helpers Node already ships instead of exporting private CRT fds or rewriting consumers: [uv_get_osfhandle](https://docs.libuv.org/en/v1.x/fs.html#c.uv_get_osfhandle) (CRT fd to OS `HANDLE`; still CRT-owned — never close it, never use it after the fd closes) and [uv_open_osfhandle](https://docs.libuv.org/en/v1.x/fs.html#c.uv_open_osfhandle) (OS `HANDLE` to CRT fd — consumes the argument; never `CloseHandle` after the call). They wrap [_get_osfhandle](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/get-osfhandle) and [_open_osfhandle](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/open-osfhandle); the latter transfers `HANDLE` ownership to the fd, which closes with `_close` (what libuv `fs__close` already does). Declarations are in the installed libuv header (`UV_EXTERN uv_os_fd_t uv_get_osfhandle(int fd);`, `UV_EXTERN int uv_open_osfhandle(uv_os_fd_t os_fd);`, new in libuv 1.12.0 / 1.23.0) and in the full Node headers shipped for addons.

Sharing prerequisites (all normative): build with [/MD](https://learn.microsoft.com/en-us/cpp/build/reference/md-mt-ld-use-run-time-library) (shared UCRT — one process-wide fd table, so the addon-created fd is the fd Node fs and child stdio see; `/MT` gives each module a private fd table and cross-boundary fds are invalid); include the full Node headers (which ship `uv.h`, unlike the minimal `node-api-headers` package); link [node.lib](https://nodejs.org/api/addons.html) per the Node addons documentation so the libuv symbols resolve to the running Node's libuv.

Ownership: `uv_open_osfhandle(h)` makes the CRT own both — closer is Node `close` / libuv `_close`. `uv_get_osfhandle(fd)` is a borrow — nobody closes it; it dies with the fd. Native handle-relative ops (§4) take the parent fd, borrow its `HANDLE` for the call, and store nothing. TS-side `close`/`read`/`write`/`fstat` and child stdio work unchanged.

## 3. Handle core: `NtCreateFile` + `RootDirectory` (normative)

All opens use user-mode [NtCreateFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile) with [OBJECT_ATTRIBUTES.RootDirectory](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/object-attributes) set to the parent directory handle and `ObjectName` set to exactly one component (`RootDirectory` resolves a relative `ObjectName` inside the supplied directory object — documented user-mode-callable NT semantics).

- `openRoot(volumePath)`: parse the volume prefix (`C:\`, UNC `\\server\share\`; reject `\\?\` caller inputs), open the volume root, walk each component with `NtCreateFile(RootDirectory=parent, FILE_OPEN, FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT, SYNCHRONIZE)`, asserting directory plus not `FILE_ATTRIBUTE_REPARSE_POINT` per step and capturing `FileIdInfo`. Never accept `.`, `..`, `/`, `\`, `:`, `? * < > |`, NUL/1..31, trailing space/dot, reserved `CON PRN AUX NUL COM1-9 LPT1-9`, ADS colon, or case-variant `..`. Rules: [naming a file](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file); tags (`SYMLINK 0xA000000C`, `MOUNT_POINT 0xA0000003`, cloud / AppExecLink / WSL): [reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points), [MS-FSCC](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/c8e77b37-3909-4fe6-a4ea-2b9d423b1ee4).
- `openAt(parentFd, name, kind)`: same single-component validator; `RootDirectory = uv_get_osfhandle(parentFd)`; `FILE_OPEN` (+ `FILE_CREATE` only for exclusive create); `FILE_OPEN_REPARSE_POINT` always; access `GENERIC_READ` (read/dir), `0` (metadata), `GENERIC_READ|GENERIC_WRITE|DELETE` as needed. Query identity (§5) immediately; non-metadata opens fail closed on reparse points. Directory opens follow the [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) `FILE_FLAG_BACKUP_SEMANTICS` + `FILE_FLAG_OPEN_REPARSE_POINT` pattern.
- Every returned `HANDLE` is converted with `uv_open_osfhandle` before crossing napi, so napi carries only CRT fds. Any reparse point is an escape unless the op explicitly opens the link itself.

## 4. Handle-relative ops (normative, no path joins)

Each op borrows the parent `HANDLE` via `uv_get_osfhandle(parentFd)`; the fd must stay open for the call.

- `statAt`: `FileIdInfo` + `FileBasicInfo` + `FileStandardInfo` + `FileAttributeTagInfo` on a metadata-access `OPEN_REPARSE_POINT` handle. Synthesize `S_IFREG`/`S_IFDIR`/`S_IFLNK`; any reparse point reports `symlink`, callers deny. ([GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandleex), [FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info), [FILE_ATTRIBUTE_TAG_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_attribute_tag_info).)
- `names`: `FileIdExtdDirectoryRestartInfo` followed by `FileIdExtdDirectoryInfo` batches on the pinned directory handle until `ERROR_NO_MORE_FILES`; skip `.`/`..`; invalid cap is `EINVAL`, accepted entries beyond cap are `E2BIG`. ([FILE_ID_EXTD_DIR_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_extd_dir_info).)
- `mkdirAt`: `NtCreateFile(RootDirectory=parent, FILE_CREATE, FILE_DIRECTORY_FILE)`.
- `renameAt` (same-parent only): `SetFileInformationByHandle` + `FILE_RENAME_INFO{ReplaceIfExists, RootDirectory=parent, FileName=one component}`; `FALSE` is exclusive (keeps `rename-worker.ts` semantics), `TRUE` is replacing publish. ([SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle), [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info).)
- `unlinkAt` / `removeDirectoryAt`: open child `OPEN_REPARSE_POINT` with `DELETE`, then `FileDispositionInfo{DeleteFile=TRUE}`; deletes the link itself, never follows; junction removal keeps the target. ([FILE_DISPOSITION_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info).)
- Staging fence: `FlushFileBuffers` on the data handle before publish; directory flush is best-effort, not part of the guarantee. ([FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).)

## 5. Identity: `FileIdInfo` strings; never Node Stats `dev:ino`

libuv on Windows fills [`uv_stat_t`](https://docs.libuv.org/en/v1.x/fs.html#data-types) lossily ([src/win/fs.c](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c)): `st_dev` is only `VolumeSerialNumber.LowPart` (32 bits), `st_ino` is the 64-bit `IndexNumber` rather than the 128-bit `FILE_ID_INFO.FileId`, and pipes get `st_ino = (uintptr_t) handle`. Node [Stats](https://nodejs.org/api/fs.html#class-fsstats) surfaces these as JS doubles, exact only to 2^53. Comparing native identity against Stats `dev:ino` doubles therefore silently aliases (ReFS, where the 64-bit index is not unique, is the sharp case).

Minimal safe changes, no consumer rewrite beyond types: Windows identity is `(VolumeSerialNumber u64, FileId u128)` surfacing only as hex strings `{vol: string, id: string}` (+ `size`, `mtimeMs`, `attrs`), never `{dev, ino: number}`. TS `same()`/`version()` gain a Windows comparator over `(vol, id)`; `PinnedDirectory.identity`, `SafeRoot.identity`, and `filesystem.ts` fingerprints use the native string identity on win32. `Descriptor.stat()` stays `fstat`-backed for data reads but is never an identity source on win32. `readBytes` unlinked-during-read maps to re-`statAt` after open; name-missing-or-different-id means `ENOENT`/`PATH_CHANGED` retry.

## 6. Pipe: numeric fds for child stdio

`pipe` keeps returning `{read, write}` numbers because §1 consumers pass them to [child stdio](https://nodejs.org/api/child_process.html#optionsstdio), `new Socket({fd})`, and `fstatSync(fd).isFIFO()`. The fds must be inheritable CRT fds in the shared UCRT (§2) — not `HANDLE`s, and not `_O_NOINHERIT` fds a child can never inherit. Exact backing (`uv_pipe` vs CRT `_pipe`) and the inheritability flag are unresolved (U4).

## 7. Real ACL private-file invariants

No `uid 0` bypass exists on Windows; ownership is owner-SID equality, never a well-known-admin shortcut. `chmodMetadata` is deleted from the Windows binding (a no-op success fakes permissions). Instead `checkPrivateAt(parentFd, name)` (`GetSecurityInfo(OWNER|DACL)`; owner SID `EqualSid` against the current token user via `GetTokenInformation(TokenUser)`; DACL `PROTECTED_DACL`, exactly one allow ACE for the owner, no inherited or other-user ACEs; `FileStandardInfo.NumberOfLinks === 1`; regular file only) and `securePrivateAt(parentFd, name)` (`SetSecurityInfo(PROTECTED_DACL_SECURITY_INFORMATION)` installing the owner-only DACL; fails closed — caller retries or reports `PERMISSION_DENIED`, never silent success). ([GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo), [SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo), [EqualSid](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-equalsid), [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation), [DACLs and ACEs](https://learn.microsoft.com/en-us/windows/win32/secauthz/dacls-and-aces).)

TS `readBytes(owner)` / `privateFileMetadata` call `checkPrivateAt` where mode/`nlink`/`uid` checks run today; `atomicWrite` staging calls `securePrivateAt` where `chmod 0600` runs today. `filesystem.ts openUpload` uses backend `openAt` + `checkPrivateAt` + identity verify.

## 8. Error mapping

`ERROR_FILE_NOT_FOUND(2)` / `ERROR_PATH_NOT_FOUND(3)` to `ENOENT`; `ERROR_FILE_EXISTS(80)` / `ERROR_ALREADY_EXISTS(183)` to `EEXIST` (exclusive `CONFLICT`); `ERROR_ACCESS_DENIED(5)` / `ERROR_SHARING_VIOLATION(32)` to `EACCES`; `ERROR_DIRECTORY(267)` to `ENOTDIR`; reparse escape to `ELOOP`; `ERROR_INVALID_NAME(123)` / bad component to `EINVAL`; cap to `E2BIG`; identity mismatch to `ESTALE`; cross-volume to `EXDEV` (no copy fallback). Codes: [system error codes](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes). AV/indexer `SHARING_VIOLATION` gets bounded retries, never infinite; cloud / AppExecLink / WSL placeholders denied by default; same-volume rename durability is NTFS journaling recovery, not a documented old-or-new-bytes proof; `MOVEFILE_WRITE_THROUGH`-equivalent flush covers only the staged data handle. The existing win32 `MoveFileExW` worker branch stays for absolute-path exclusive moves only: [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

## 9. Rejected alternatives

`GetFinalPathNameByHandle` + child join plus parent recheck: ancestor ABA between join and open acts before detection — rejected. `DeleteFileW` / `RemoveDirectory` / `MoveFileExW` path joins for descriptor ops: same TOCTOU — rejected. HANDLE-only backend: breaks every §1 numeric-fd consumer — rejected (§2 bridges instead). Private-CRT fd export without `/MD` + `node.lib` shared-UCRT gates: cross-CRT invalidation — rejected (§2). `chmodMetadata` no-op success: fakes permissions — rejected (§7 uses real DACLs). 128-bit `FileId` in JS doubles: precision loss / ReFS aliasing — rejected (§5 strings). Reparse tag-allowlist: over-broad class, deny-all unless link-itself — rejected. koffi-per-call paths for pinned ops: cannot pin handles — rejected (native addon only).

## 10. Smallest native core task interface

```c
// napi carries only ints (shared-UCRT CRT fds) and strings. HANDLEs never
// cross napi; each call borrows via uv_get_osfhandle(fd) and stores nothing.
int openRoot(const char* volumePath);                 // walk -> uv_open_osfhandle -> fd
int openAt(int parentFd, const char* name, int kind); // RootDirectory open -> fd
int openMetadataAt(int parentFd, const char* name);   // zero-access, link-itself -> fd
void mkdirAt(int parentFd, const char* name);
void renameAt(int parentFd, const char* from, const char* to, int replace);
void unlinkAt(int parentFd, const char* name);
void removeDirectoryAt(int parentFd, const char* name);
Stat statAt(int parentFd, const char* name);          // {vol,id,size,mtimeMs,attrs} strings
Names names(int dirFd, int cap);                      // at most 10000, no . / ..
Pipe pipe(void);                                      // {read, write} inheritable CRT fds (U4)
Ident identityOf(int fd);                             // FileIdInfo over borrowed HANDLE
void checkPrivateAt(int parentFd, const char* name);  // §7, fails closed
void securePrivateAt(int parentFd, const char* name); // §7, fails closed
```

No native `close`: fd lifetime stays with TS `Descriptor` via Node `close`, which routes through libuv `_close` and releases the `HANDLE`. No native read/write: Node fs operates on the bridged fds directly.

## 11. Unresolved contracts (verify on a Windows host; not normative)

- U1: `node.lib` on win-x64 and win-arm64 exports `uv_open_osfhandle` / `uv_get_osfhandle` for addon linkage; the link check is the first gate.
- U2: `NtCreateFile` handles (including directory handles and zero-access metadata handles) are accepted by `uv_open_osfhandle`, and the resulting fd works with Node `read` / `write` / `fstat` / `close`.
- U3: the `uv_get_osfhandle(fd)` borrowed `HANDLE` is valid for `NtCreateFile(RootDirectory=...)`, `SetFileInformationByHandle`, `GetFileInformationByHandleEx`, and `GetSecurityInfo` while the fd is open.
- U4: pipe backing and inheritability flag such that the child sees the fd in stdio and `fstatSync(fd).isFIFO()` holds.
- U5: ReFS behavior of the 64-bit index; until measured, §5 assumes it is unsafe and uses only 128-bit string identity.
- U6: AV/indexer retry bounds, OneDrive-placeholder denial fallout, `MAX_PATH` vs long-path opt-in per builder, power-loss durability limits.

## 12. Open risks

No Windows host run yet: every mapping above comes from primary docs and sources, so U1–U6 gate implementation. Integration requires real win-x64 AND win-arm64 hosts at merge, Electron `daemon/descriptor.node` staging check, and `docs/verification/windows-workspace-checklist.md`. No merge with either arch red.
