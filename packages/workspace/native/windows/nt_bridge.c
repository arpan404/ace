// NT bridge for the Windows handle core: ntdll dynamic load, UTF-8 to
// UTF-16 conversion, single-component NtCreateFile opens, Win32-to-POSIX
// error mapping, and reparse/type assertions.
//
// Primary sources:
// - NtCreateFile signature, RootDirectory relative resolution, CreateOptions
//   values (FILE_DIRECTORY_FILE 0x1, FILE_NON_DIRECTORY_FILE 0x40,
//   FILE_SYNCHRONOUS_IO_NONALERT 0x20, FILE_OPEN_REPARSE_POINT 0x200000),
//   "generic rights cannot be specified for a directory", and reparse-point
//   remarks: Microsoft Learn "NtCreateFile function (ntifs.h)"
//   (https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile).
// - OBJECT_ATTRIBUTES field layout: Microsoft Learn "OBJECT_ATTRIBUTES"
//   (https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/object-attributes).
//   OBJ_* attribute values from WDK wdm.h; only OBJ_CASE_INSENSITIVE is set —
//   OBJ_INHERIT is deliberately never set, so every handle is non-inheritable.
// - NTSTATUS-to-Win32 mapping: RtlNtStatusToDosError resolved from ntdll.dll
//   (see the NtCreateFile requirements section: user-mode calls use the
//   "NtCreateFile" name; api_location lists ntdll.dll).
// - Error code table: Microsoft Learn "System Error Codes"
//   (https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes).
// - GetFileInformationByHandleEx + FileAttributeTagInfo: Windows SDK
//   fileapi.h (symbolic names only, no literals).
//
// Unresolved on this host (verify on a Windows VM; see build probe):
// - U1: node.lib exports uv_open_osfhandle/uv_get_osfhandle (link gate).
// - U3: the borrowed HANDLE is valid for NtCreateFile(RootDirectory=...).

#ifdef _WIN32
// InitOnceExecuteOnce requires _WIN32_WINNT >= 0x0600 (Vista+); pin to the
// Win10 baseline (0x0A00, covers 1903) so the declaration is always present.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <uv.h>
#include <windows.h>
#include "windows_core.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// NTSTATUS is a 32-bit signed status; NT_SUCCESS(x) is ((LONG)(x) >= 0)
// (ntstatus.h convention; only the sign bit is interpreted here).
typedef LONG WCORE_NTSTATUS;
#define WCORE_NT_SUCCESS(s) (((LONG)(s)) >= 0)

// Minimal user-mode mirror of the NT structures. Field layout per the
// OBJECT_ATTRIBUTES documentation and WDK wdm.h.
typedef struct {
  USHORT Length; // bytes, excluding NUL
  USHORT MaximumLength; // bytes
  PWSTR Buffer;
} WCORE_UNICODE_STRING;

typedef struct {
  ULONG Length;
  HANDLE RootDirectory;
  WCORE_UNICODE_STRING *ObjectName;
  ULONG Attributes;
  PVOID SecurityDescriptor;
  PVOID SecurityQualityOfService;
} WCORE_OBJECT_ATTRIBUTES;

typedef struct {
  union {
    WCORE_NTSTATUS Status;
    PVOID Pointer;
  };
  ULONG_PTR Information;
} WCORE_IO_STATUS_BLOCK;

// OBJ_CASE_INSENSITIVE from WDK wdm.h. OBJ_INHERIT is intentionally never
// used (see wcore_nt_create_child below).
#define WCORE_OBJ_CASE_INSENSITIVE 0x00000040UL

typedef WCORE_NTSTATUS(NTAPI *wcore_nt_create_file_fn)(PHANDLE, ACCESS_MASK,
    WCORE_OBJECT_ATTRIBUTES *, WCORE_IO_STATUS_BLOCK *, PLARGE_INTEGER, ULONG,
    ULONG, ULONG, ULONG, PVOID, ULONG);
typedef ULONG(NTAPI *wcore_rtl_nt_to_dos_fn)(WCORE_NTSTATUS);

static INIT_ONCE g_nt_once = INIT_ONCE_STATIC_INIT;
static wcore_nt_create_file_fn g_nt_create = NULL;
static wcore_rtl_nt_to_dos_fn g_nt_to_dos = NULL;

// One-time ntdll resolution. Runs exactly once via InitOnceExecuteOnce, so
// concurrent Node Worker opens block until both symbols are fully published.
// Locals hold the probe results; the globals are published together (either
// a valid pair or NULL/NULL), then TRUE is returned to cache the outcome
// permanently — including ENOSYS — with no partially published pointers and
// no transient failure for a racing caller.
//
// Primary source: InitOnceExecuteOnce one-time initialization semantics
// (https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-initonceexecuteonce).
static BOOL CALLBACK wcore_init_ntdll(PINIT_ONCE once, PVOID param, PVOID *ctx) {
  (void)once;
  (void)param;
  (void)ctx;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  wcore_nt_create_file_fn create = NULL;
  wcore_rtl_nt_to_dos_fn to_dos = NULL;
  if (ntdll != NULL) {
    create =
        (wcore_nt_create_file_fn)(void *)GetProcAddress(ntdll, "NtCreateFile");
    to_dos = (wcore_rtl_nt_to_dos_fn)(void *)GetProcAddress(
        ntdll, "RtlNtStatusToDosError");
  }
  if (create == NULL || to_dos == NULL) {
    create = NULL;
    to_dos = NULL;
  }
  g_nt_create = create;
  g_nt_to_dos = to_dos;
  return TRUE;
}

static const char *wcore_load_ntdll(void) {
  if (!InitOnceExecuteOnce(&g_nt_once, wcore_init_ntdll, NULL, NULL))
    return "ENOSYS";
  return g_nt_create != NULL ? NULL : "ENOSYS";
}

const char *wcore_dos_to_code(DWORD dos) {
  switch (dos) {
    case ERROR_SUCCESS:
      return NULL;
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
      return "ENOENT";
    case ERROR_ACCESS_DENIED:
      // AV/indexer SHARING_VIOLATION is also access-denied shaped; bounded
      // retries are the caller's policy (U6), never infinite here.
    case ERROR_SHARING_VIOLATION:
      return "EACCES";
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS:
      return "EEXIST";
    case ERROR_INVALID_NAME:
      return "EINVAL";
    case ERROR_DIRECTORY:
      return "ENOTDIR";
    case ERROR_FILENAME_EXCED_RANGE:
      return "ENAMETOOLONG";
    case ERROR_NOT_SUPPORTED:
      return "ENOTSUP";
    default:
      return "EIO";
  }
}

// Convert exactly `bytes` UTF-8 bytes (no NUL required) to UTF-16.
// MB_ERR_INVALID_CHARS makes malformed input fail closed instead of
// substituting U+FFFD (stringapiset docs).
const char *wcore_wide_from_utf8(
    const char *utf8, size_t bytes, WCHAR *wide, DWORD cap, DWORD *used) {
  if (bytes == 0 || bytes > INT_MAX || cap == 0) return "EINVAL";
  int count = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, utf8, (int)bytes, wide, (int)cap);
  if (count <= 0) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EINVAL";
  }
  *used = (DWORD)count;
  return NULL;
}

// Open one relative component inside `parent` without any path join.
// The caller picks directory vs file semantics via `options`.
static const char *nt_open_child(HANDLE parent, const WCHAR *wname, DWORD wlen,
    ULONG options, ACCESS_MASK access, ULONG disposition, HANDLE *out) {
  const char *load = wcore_load_ntdll();
  if (load != NULL) return load;
  if (parent == NULL || parent == INVALID_HANDLE_VALUE || wname == NULL ||
      wlen == 0 || out == NULL)
    return "EINVAL";
  WCORE_UNICODE_STRING uname;
  uname.Length = (USHORT)(wlen * sizeof(WCHAR));
  uname.MaximumLength = uname.Length;
  uname.Buffer = (PWSTR)wname;
  WCORE_OBJECT_ATTRIBUTES attr;
  attr.Length = sizeof(attr);
  attr.RootDirectory = parent;
  attr.ObjectName = &uname;
  // Case-insensitive lookup without OBJ_INHERIT: non-inheritable handle.
  attr.Attributes = WCORE_OBJ_CASE_INSENSITIVE;
  attr.SecurityDescriptor = NULL;
  attr.SecurityQualityOfService = NULL;
  WCORE_IO_STATUS_BLOCK iosb;
  memset(&iosb, 0, sizeof(iosb));
  HANDLE handle = NULL;
  WCORE_NTSTATUS status = g_nt_create(&handle, access, &attr, &iosb, NULL,
      FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE |
          FILE_SHARE_DELETE,
      disposition, options, NULL, 0);
  if (!WCORE_NT_SUCCESS(status)) {
    // FILE_CREATE never opens an existing object. The directory constraint
    // can report its type before collision; preserve exclusive-create semantics.
    if (disposition == 2UL &&
        ((ULONG)status == 0xC00000BAUL || (ULONG)status == 0xC0000103UL))
      return "EEXIST";
    // RtlNtStatusToDosError loses type information: FILE_IS_A_DIRECTORY
    // becomes ACCESS_DENIED on real Windows. Preserve the NT type codes.
    // https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55
    const char *code = (ULONG)status == 0xC00000BAUL ? "EISDIR"
        : (ULONG)status == 0xC0000103UL ? "ENOTDIR"
        : wcore_dos_to_code(g_nt_to_dos(status));
    // A type constraint can reject a reparse point before its tag is read.
    // Refine that refusal using an untyped, no-follow metadata handle.
    // This path never admits an operation, even if the name changes again.
    if (disposition == WCORE_FILE_OPEN_DISPOSITION &&
        ((ULONG)status == 0xC00000BAUL || (ULONG)status == 0xC0000103UL) &&
        (options & (WCORE_FILE_DIRECTORY_FILE | WCORE_FILE_NON_DIRECTORY_FILE))) {
      HANDLE metadata = NULL;
      const char *probe = nt_open_child(parent, wname, wlen,
          WCORE_FILE_SYNCHRONOUS_IO_NONALERT | WCORE_FILE_OPEN_REPARSE_POINT,
          FILE_READ_ATTRIBUTES | SYNCHRONIZE, WCORE_FILE_OPEN_DISPOSITION,
          &metadata);
      if (probe == NULL) {
        const char *link = wcore_assert_noreparse(metadata);
        CloseHandle(metadata);
        if (link != NULL && strcmp(link, "ELOOP") == 0) return link;
      }
    }
    return code != NULL ? code : "EIO";
  }
  *out = handle;
  return NULL;
}

const char *wcore_nt_create_child(HANDLE parent, const WCHAR *wname, DWORD wlen,
    ULONG options, ACCESS_MASK access, HANDLE *out) {
  return nt_open_child(parent, wname, wlen, options, access,
      WCORE_FILE_OPEN_DISPOSITION, out);
}

const char *wcore_nt_create_new_child(HANDLE parent, const WCHAR *wname, DWORD wlen,
    ULONG options, ACCESS_MASK access, HANDLE *out) {
  // FILE_CREATE (2): fail with collision if any object already has this name.
  return nt_open_child(parent, wname, wlen, options, access, 2UL, out);
}

const char *wcore_assert_noreparse(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info;
  memset(&info, 0, sizeof(info));
  if (!GetFileInformationByHandleEx(
          handle, FileAttributeTagInfo, &info, sizeof(info))) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  // Deny-all unless the op explicitly opens the link itself. This core has no
  // link-itself op yet, so any reparse point is an escape: ELOOP.
  if (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return "ELOOP";
  return NULL;
}

const char *wcore_assert_dir_noreparse(HANDLE handle) {
  const char *reparse = wcore_assert_noreparse(handle);
  if (reparse != NULL) return reparse;
  FILE_ATTRIBUTE_TAG_INFO info;
  memset(&info, 0, sizeof(info));
  if (!GetFileInformationByHandleEx(
          handle, FileAttributeTagInfo, &info, sizeof(info))) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  if (!(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)) return "ENOTDIR";
  return NULL;
}

// Single shared fd borrow wrapper (declared in windows_core.h).
//
// Primary sources: _get_osfhandle invokes the CRT invalid-parameter handler
// on a bad/closed fd and returns INVALID_HANDLE_VALUE (-1), or -2 for a
// detached stdio fd 0/1/2 with no console (Microsoft Learn "_get_osfhandle");
// libuv docs "Helper functions" documents uv_get_osfhandle as the borrowed
// wrapper (new 1.12.0). The CRT parameter-validation docs note the default
// handler terminates via Watson; _set_thread_local_invalid_parameter_handler
// (<stdlib.h>) scopes a replacement to this thread. Node already initialized
// the CRT, but this boundary still installs its own thread-local no-op
// handler around the synchronous uv_get_osfhandle call and restores the
// previous handler, so a bad fd fails closed with EBADF instead of aborting.
// No global handler, no private CRT fd table use.
static void __cdecl wcore_ignore_invalid_parameter(const wchar_t *expression,
    const wchar_t *function, const wchar_t *file, unsigned int line,
    uintptr_t reserved) {
  (void)expression;
  (void)function;
  (void)file;
  (void)line;
  (void)reserved;
}

const char *wcore_borrow_handle(int fd, HANDLE *out) {
  if (fd < 0 || out == NULL) return "EINVAL";
  _invalid_parameter_handler prev =
      _set_thread_local_invalid_parameter_handler(
          wcore_ignore_invalid_parameter);
  uv_os_fd_t borrowed = uv_get_osfhandle(fd);
  _set_thread_local_invalid_parameter_handler(prev);
  if (borrowed == (uv_os_fd_t)INVALID_HANDLE_VALUE ||
      borrowed == (uv_os_fd_t)-2 || borrowed == 0)
    return "EBADF";
  *out = (HANDLE)borrowed;
  return NULL;
}

const char *wcore_close_fd(int fd) {
  uv_fs_t request;
  int result = uv_fs_close(NULL, &request, fd, NULL);
  uv_fs_req_cleanup(&request);
  return result < 0 ? uv_err_name(result) : NULL;
}
#endif
