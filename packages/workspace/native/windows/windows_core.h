// Bounded Windows workspace handle core (W04 first cut) — shared declarations.
//
// Scope: pinned opens, exclusive file/directory creation, metadata, enumeration and
// lossless FileIdInfo identity. No ACL or pipe yet. HANDLEs never cross NAPI;
// every returned handle is converted with uv_open_osfhandle before NAPI
// carries it, so NAPI carries only CRT fds. Each call borrows parent HANDLEs
// via uv_get_osfhandle and stores nothing.
//
// Primary sources:
// - NtCreateFile + CreateOptions values + RootDirectory relative-resolve
//   semantics: Microsoft Learn "NtCreateFile function (ntifs.h)"
//   (https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile)
// - OBJECT_ATTRIBUTES layout: Microsoft Learn "OBJECT_ATTRIBUTES"
//   (https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/object-attributes)
// - libuv fd bridge: libuv docs "Helper functions"
//   (https://docs.libuv.org/en/v1.x/fs.html) — uv_get_osfhandle (new 1.12.0,
//   wraps _get_osfhandle, borrowed) and uv_open_osfhandle (new 1.23.0, wraps
//   _open_osfhandle, consumes the HANDLE; never CloseHandle after the call).
// - Build prerequisites (/MD addon, full Node headers shipping uv.h,
//   node.lib linkage): Node addons docs (https://nodejs.org/api/addons.html)
//   and MSVC /MD docs
//   (https://learn.microsoft.com/en-us/cpp/build/reference/md-mt-ld-use-run-time-library).
// - Component lexical rules: Microsoft Learn "Naming Files, Paths, and
//   Namespaces" (https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).
// - Identity: GetFileInformationByHandleEx + FILE_ID_INFO
//   (https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex).
//
// First-cut limitations (explicit, no silent fallback):
// - UNC roots (\\server\share\...) are refused with ENOTSUP and a UNC-specific
//   message until handle-relative UNC traversal lands.
// - Returned fds are non-inheritable. Child stdio inheritance is done later by
//   explicitly duplicating the needed fds into the child stdio array; nothing
//   here claims every fd must be globally inheritable.
//
// Error convention: core functions return NULL on success, else a static
// POSIX code string ("ENOENT", "ELOOP", ...). No errno.h values cross the
// boundary, so no CRT errno portability assumptions. The NAPI layer turns the
// code into a JS Error with a `code` property.
#ifndef ACE_WINDOWS_CORE_H
#define ACE_WINDOWS_CORE_H

#include <stddef.h>

#ifdef _WIN32
#include <windows.h>
#endif

// Portable single-component lexical validator (no Win32 calls, so the logic
// is host-independent). Returns NULL when `name[0..len)` is acceptable,
// else a POSIX code string (always "EINVAL" for lexical rejections).
// Rejects: empty/overlong, embedded NUL, '/', '\\', ':', '"', '<', '>', '|',
// '?', '*', bytes 1..31, '.', '..', trailing space/dot, ADS colon, reserved
// stems (CON PRN AUX NUL COM1-9 LPT1-9 + superscript COM/LPT 1-3,
// case-insensitive, with or without extension).
const char *wcore_validate_component(const char *name, size_t len);

#ifdef _WIN32
// Map a Win32 error (from GetLastError or RtlNtStatusToDosError) to a POSIX
// code string, or NULL for ERROR_SUCCESS.
const char *wcore_dos_to_code(DWORD dos);

// Assert a HANDLE is a directory and not a reparse point, without following
// anything. Returns NULL when both hold, else "ENOTDIR"/"ELOOP"/mapped code.
const char *wcore_assert_dir_noreparse(HANDLE handle);

// Assert a HANDLE is not a reparse point. Returns NULL or "ELOOP"/mapped code.
const char *wcore_assert_noreparse(HANDLE handle);

// Open the volume root or a volume-relative path by walking one component at
// a time with NtCreateFile(RootDirectory=parent). Never joins an absolute
// child path. UNC roots are refused (ENOTSUP + UNC message via out path).
// On success stores a CRT fd in *out_fd (via uv_open_osfhandle).
const char *wcore_open_root(const char *volume_path, int *out_fd);

// Open one validated component relative to a borrowed parent fd:
// directory (fails closed unless directory, never follows reparse).
const char *wcore_open_dir_at(int parent_fd, const char *name, int *out_fd);

// Open one validated component relative to a borrowed parent fd:
// regular file (fails closed on directories and reparse points).
const char *wcore_open_file_at(int parent_fd, const char *name, int *out_fd);

// Exclusively create a regular file. Existing files, links and directories
// are never overwritten. The writable fd remains owned by Node.
const char *wcore_create_file_at(int parent_fd, const char *name, int *out_fd);
const char *wcore_mkdir_at(int parent_fd, const char *name);

// Lossless identity of an open fd: VolumeSerialNumber as 16 lowercase hex
// chars plus the 128-bit FileId as 32 lowercase hex chars (raw identifier
// byte order, string equality only — never truncated to JS doubles).
const char *wcore_identity_of(int fd, char vol_hex[17], char id_hex[33]);

// Shared lossless identity formatting (single owner: file_identity.c).
// VolumeSerialNumber as 16 zero-padded lowercase hex chars (MSB first);
// 128-bit FileId as 32 lowercase hex chars in stored byte order.
void wcore_format_vol(ULONGLONG vol, char out[17]);
void wcore_format_id(const FILE_ID_128 *id, char out[33]);

// Metadata: stat one validated component relative to a borrowed parent fd.
// Opens with NtCreateFile(RootDirectory=parent, OPEN_REPARSE_POINT) and no
// absolute join; queries FileIdInfo + FileBasicInfo + FileStandardInfo +
// FileAttributeTagInformation on the SAME handle (never Node Stats doubles).
// Any reparse point reports S_IFLNK; callers deny. Returns vol/id hex
// (same lossless stored-order format as identityOf) plus synthesized POSIX
// mode, size bytes, Unix mtimeMs double, and raw FileAttributes.
const char *wcore_stat_at(int parent_fd, const char *name, char vol_hex[17],
    char id_hex[33], unsigned int *mode, unsigned long long *size,
    double *mtime_ms, unsigned int *attrs);

// Directory enumeration: FileIdExtdDirectoryInfo on the borrowed
// directory handle; skips "." / ".."; cap 1..10000 else EINVAL; more than
// cap accepted entries is E2BIG. Calls sink once per accepted name
// (UTF-8, len bytes, NUL-terminated; Unicode preserved). Malformed UTF-16,
// embedded NUL, or bounds violations fail closed. Count in out_count.
typedef int (*wcore_name_sink_fn)(const char *utf8, size_t len, void *ctx);
const char *wcore_names_collect(int dir_fd, int cap, wcore_name_sink_fn sink,
    void *ctx, int *out_count);

// Borrow the OS HANDLE for a CRT fd without taking ownership (never close
// or store it; the fd must stay open for the call). Single shared wrapper
// used by child opens and identity (see nt_bridge.c for the definition).
//
// Validation and borrowing both run through Node's libuv, never the addon
// CRT. The caller must keep the fd open through this synchronous call.
// Node 24's default Windows build uses /MT, so /MD on the addon does not
// make CRT descriptor tables or invalid-parameter handlers interchangeable.
const char *wcore_borrow_handle(int fd, HANDLE *out);

// Close a newly acquired Node-owned fd through Node's libuv. The addon CRT
// can have a different descriptor table even when it is built with /MD.
const char *wcore_close_fd(int fd);

// --- NT-bridge internals shared by volume_root.c and child_open.c ---
// CreateOptions values from the NtCreateFile docs table; CreateDisposition
// FILE_OPEN from WDK ntifs.h (only FILE_OPEN is used: missing names must
// fail, never create).
#define WCORE_FILE_DIRECTORY_FILE 0x00000001UL
#define WCORE_FILE_NON_DIRECTORY_FILE 0x00000040UL
#define WCORE_FILE_SYNCHRONOUS_IO_NONALERT 0x00000020UL
#define WCORE_FILE_OPEN_REPARSE_POINT 0x00200000UL
#define WCORE_FILE_OPEN_DISPOSITION 0x00000001UL
#define WCORE_OPTS_DIR \
  (WCORE_FILE_DIRECTORY_FILE | WCORE_FILE_SYNCHRONOUS_IO_NONALERT | WCORE_FILE_OPEN_REPARSE_POINT)
#define WCORE_OPTS_FILE \
  (WCORE_FILE_NON_DIRECTORY_FILE | WCORE_FILE_SYNCHRONOUS_IO_NONALERT | WCORE_FILE_OPEN_REPARSE_POINT)

// UTF-8 (exactly `bytes`, no NUL required) to UTF-16; fails closed on
// malformed input. `used` receives wide chars excluding NUL.
const char *wcore_wide_from_utf8(
    const char *utf8, size_t bytes, WCHAR *wide, DWORD cap, DWORD *used);

// Open one relative component inside `parent` (RootDirectory, no path join).
const char *wcore_nt_create_child(HANDLE parent, const WCHAR *wname, DWORD wlen,
    ULONG options, ACCESS_MASK access, HANDLE *out);
const char *wcore_nt_create_new_child(HANDLE parent, const WCHAR *wname, DWORD wlen,
    ULONG options, ACCESS_MASK access, HANDLE *out);
#endif

#endif
