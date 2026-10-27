// Windows counterpart of ../descriptor.c: handle-relative NtCreateFile calls on Node fds.
// Name rules, identity formatting and mode synthesis live in TypeScript.
#ifdef _WIN32
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <node_api.h>
#include <uv.h>
#include <windows.h>
#include <winioctl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define NAME_BYTES 1024
#define OPT_REPARSE 0x00200000UL
#define OPT_SYNC 0x00000020UL
#define OPT_DIRECTORY 0x00000001UL
#define OPT_FILE 0x00000040UL
#define OPT_OPEN 1UL
#define OPT_CREATE 2UL
#define NT_IS_DIRECTORY 0xC00000BAUL
#define NT_NOT_DIRECTORY 0xC0000103UL

// FILE_DISPOSITION_INFO_EX (Windows 10 1809+), declared here so older SDK headers still build.
typedef struct { DWORD Flags; } DISPOSITION_EX_T;
#define DISPOSITION_EX_CLASS ((FILE_INFO_BY_HANDLE_CLASS)21)
#define DISPOSITION_DELETE 0x00000001UL
#define DISPOSITION_IGNORE_READONLY 0x00000010UL

typedef LONG NTSTATUS_T;
typedef struct { USHORT Length, MaximumLength; PWSTR Buffer; } UNICODE_STRING_T;
typedef struct {
  ULONG Length;
  HANDLE RootDirectory;
  UNICODE_STRING_T *ObjectName;
  ULONG Attributes;
  PVOID SecurityDescriptor, SecurityQualityOfService;
} OBJECT_ATTRIBUTES_T;
typedef struct { union { NTSTATUS_T Status; PVOID Pointer; }; ULONG_PTR Information; } IO_STATUS_T;
typedef NTSTATUS_T(NTAPI *create_fn)(PHANDLE, ACCESS_MASK, OBJECT_ATTRIBUTES_T *, IO_STATUS_T *,
    PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS_T(NTAPI *set_fn)(HANDLE, IO_STATUS_T *, PVOID, ULONG, ULONG);
typedef ULONG(NTAPI *to_dos_fn)(NTSTATUS_T);

static INIT_ONCE once = INIT_ONCE_STATIC_INIT;
static create_fn nt_create;
static set_fn nt_set;
static to_dos_fn nt_to_dos;

static BOOL CALLBACK load_ntdll(PINIT_ONCE unused, PVOID param, PVOID *context) {
  (void)unused; (void)param; (void)context;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == NULL) return TRUE;
  create_fn create = (create_fn)(void *)GetProcAddress(ntdll, "NtCreateFile");
  set_fn set = (set_fn)(void *)GetProcAddress(ntdll, "NtSetInformationFile");
  to_dos_fn to_dos = (to_dos_fn)(void *)GetProcAddress(ntdll, "RtlNtStatusToDosError");
  if (create && set && to_dos) { nt_create = create; nt_set = set; nt_to_dos = to_dos; }
  return TRUE;
}
static const char *code_of(DWORD dos) {
  switch (dos) {
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: return "ENOENT";
    case ERROR_ACCESS_DENIED: case ERROR_SHARING_VIOLATION: return "EACCES";
    case ERROR_FILE_EXISTS: case ERROR_ALREADY_EXISTS: return "EEXIST";
    case ERROR_INVALID_PARAMETER: case ERROR_INVALID_NAME: return "EINVAL";
    case ERROR_DIR_NOT_EMPTY: return "ENOTEMPTY";
    case ERROR_DIRECTORY: return "ENOTDIR";
    default: return "EIO";
  }
}
static const char *last_error(void) { return code_of(GetLastError()); }
static napi_value fail(napi_env env, const char *code) {
  napi_value message, error, value;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, NULL, message, &error);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, error, "code", value);
  napi_throw(env, error);
  return NULL;
}
static napi_value done(napi_env env, const char *code) {
  napi_value result;
  if (code) return fail(env, code);
  napi_get_undefined(env, &result);
  return result;
}
// napi_get_value_int32 maps NaN to 0 (stdin), so fds must be exact integers.
static int read_int(napi_env env, napi_value value, int32_t low, int32_t high, int32_t *out) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok || !(number >= low && number <= high) ||
      (double)(int32_t)number != number) return 0;
  *out = (int32_t)number;
  return 1;
}
static int is_separator(char c) { return c == '\\' || c == '/'; }
// One component only: no NUL, separator, "." or ".." can reach a relative open.
static const char *wide_component(const char *name, size_t size, WCHAR *wide, DWORD *length) {
  if (size == 0 || size > NAME_BYTES || memchr(name, '\0', size)) return "EINVAL";
  for (size_t i = 0; i < size; i++) if (is_separator(name[i])) return "EINVAL";
  if ((size == 1 && name[0] == '.') || (size == 2 && name[0] == '.' && name[1] == '.')) return "EINVAL";
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, (int)size, wide, NAME_BYTES);
  if (count <= 0) return "EINVAL";
  *length = (DWORD)count;
  return NULL;
}
static int read_name(napi_env env, napi_value value, WCHAR *wide, DWORD *length) {
  char name[NAME_BYTES + 1];
  size_t size;
  if (napi_get_value_string_utf8(env, value, name, sizeof(name), &size) != napi_ok ||
      size >= NAME_BYTES) return 0;
  return wide_component(name, size, wide, length) == NULL;
}
static const char *attributes_of(HANDLE handle, DWORD *attributes) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))) return last_error();
  *attributes = tag.FileAttributes;
  return NULL;
}
// Traversal requires a real directory: a junction or symlink is never a parent.
static const char *plain_directory(HANDLE handle) {
  DWORD attributes;
  const char *code = attributes_of(handle, &attributes);
  if (code) return code;
  if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) return "ELOOP";
  return attributes & FILE_ATTRIBUTE_DIRECTORY ? NULL : "ENOTDIR";
}
// Validates the fd through Node's libuv: the addon CRT may not share Node's fd table.
static const char *borrow(int32_t fd, HANDLE *out) {
  uv_fs_t request;
  int checked = uv_fs_fstat(NULL, &request, fd, NULL);
  uv_fs_req_cleanup(&request);
  if (checked < 0) return uv_err_name(checked);
  uv_os_fd_t handle = uv_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE || handle == (uv_os_fd_t)-2 || handle == NULL) return "EBADF";
  *out = (HANDLE)handle;
  return NULL;
}
static napi_value adopt(napi_env env, HANDLE handle) {
  napi_value result;
  int fd = uv_open_osfhandle((uv_os_fd_t)handle);
  if (fd < 0) { CloseHandle(handle); return fail(env, "EMFILE"); }
  napi_create_int32(env, fd, &result);
  return result;
}
static const char *open_child(HANDLE parent, WCHAR *name, DWORD length, ULONG options,
    ACCESS_MASK access, ULONG disposition, HANDLE *out) {
  if (!InitOnceExecuteOnce(&once, load_ntdll, NULL, NULL) || nt_create == NULL) return "ENOSYS";
  UNICODE_STRING_T text = {(USHORT)(length * sizeof(WCHAR)), (USHORT)(length * sizeof(WCHAR)), name};
  // Case-insensitive like Win32, and never OBJ_INHERIT.
  OBJECT_ATTRIBUTES_T object = {sizeof(object), parent, &text, 0x40UL, NULL, NULL};
  IO_STATUS_T io;
  NTSTATUS_T status = nt_create(out, access, &object, &io, NULL, FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, disposition, options | OPT_SYNC, NULL, 0);
  if (status >= 0) return NULL;
  ULONG raw = (ULONG)status;
  if (raw == NT_IS_DIRECTORY || raw == NT_NOT_DIRECTORY) return "EEXIST";
  return code_of(nt_to_dos(status));
}
// Reads (fd, name) and opens that child of a plain directory.
static const char *child_args(napi_env env, napi_callback_info info, size_t expected,
    napi_value *args, HANDLE *parent, WCHAR *name, DWORD *length) {
  int32_t fd;
  size_t count = expected;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != expected ||
      !read_int(env, args[0], 0, INT32_MAX, &fd) || !read_name(env, args[1], name, length))
    return "EINVAL";
  const char *code = borrow(fd, parent);
  return code ? code : plain_directory(*parent);
}

// Opens a child without following it; `plain` refuses a junction or symlink (ELOOP).
static napi_value child_at(napi_env env, napi_callback_info info, ULONG options, ACCESS_MASK access,
    ULONG disposition, int plain, int keep) {
  napi_value args[2];
  HANDLE parent = NULL, child = NULL;
  WCHAR name[NAME_BYTES];
  DWORD length, attributes;
  const char *code = child_args(env, info, 2, args, &parent, name, &length);
  if (!code) code = open_child(parent, name, length, options | OPT_REPARSE, access, disposition, &child);
  if (code) return fail(env, code);
  if (plain) {
    code = attributes_of(child, &attributes);
    if (!code && (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) code = "ELOOP";
  }
  if (code || !keep) { CloseHandle(child); return done(env, code); }
  return adopt(env, child);
}
#define DIRECTORY_ACCESS (FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
// A file or a directory (Windows has no O_DIRECTORY); TypeScript checks the type it needs.
static napi_value open_at(napi_env env, napi_callback_info info) {
  return child_at(env, info, 0, FILE_GENERIC_READ, OPT_OPEN, 1, 1);
}
static napi_value create_file_at(napi_env env, napi_callback_info info) {
  return child_at(env, info, OPT_FILE, FILE_GENERIC_READ | FILE_GENERIC_WRITE, OPT_CREATE, 1, 1);
}
static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  return child_at(env, info, OPT_DIRECTORY, DIRECTORY_ACCESS, OPT_CREATE, 1, 0);
}
// The link itself, never its target, with attribute access only.
static napi_value open_metadata_at(napi_env env, napi_callback_info info) {
  return child_at(env, info, 0, FILE_READ_ATTRIBUTES | SYNCHRONIZE, OPT_OPEN, 0, 1);
}
// Deletes the opened entry itself (a junction, never its target) when its handle closes.
static napi_value delete_at(napi_env env, napi_callback_info info, DWORD directory) {
  napi_value args[2];
  HANDLE parent = NULL, child = NULL;
  WCHAR name[NAME_BYTES];
  DWORD length, attributes;
  const char *code = child_args(env, info, 2, args, &parent, name, &length);
  if (!code) code = open_child(parent, name, length, OPT_REPARSE,
      DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE, OPT_OPEN, &child);
  if (code) return fail(env, code);
  code = attributes_of(child, &attributes);
  if (!code && (attributes & FILE_ATTRIBUTE_DIRECTORY) != directory)
    code = directory ? "ENOTDIR" : "EISDIR";
  // Delete even a read-only entry (Git's object files are read-only); a file system without the
  // extended class (Windows 10 before 1809, FAT) keeps the plain disposition.
  DISPOSITION_EX_T extended = {DISPOSITION_DELETE | DISPOSITION_IGNORE_READONLY};
  FILE_DISPOSITION_INFO disposition = {TRUE};
  if (!code && !SetFileInformationByHandle(child, DISPOSITION_EX_CLASS, &extended, sizeof(extended))) {
    DWORD error = GetLastError();
    if (error != ERROR_INVALID_PARAMETER && error != ERROR_NOT_SUPPORTED &&
        error != ERROR_INVALID_FUNCTION)
      code = code_of(error);
    else if (!SetFileInformationByHandle(child, FileDispositionInfo, &disposition, sizeof(disposition)))
      code = last_error();
  }
  if (!CloseHandle(child) && !code) code = last_error();
  return done(env, code);
}
static napi_value unlink_at(napi_env env, napi_callback_info info) { return delete_at(env, info, 0); }
static napi_value remove_directory_at(napi_env env, napi_callback_info info) {
  return delete_at(env, info, FILE_ATTRIBUTE_DIRECTORY);
}
// Moves `from` to `to` in the same parent. Win32's rename wrapper rejects a relative target.
// An optional fourth argument `replace` (default true) set to false fails with EEXIST instead
// of replacing an existing `to`, atomically in the file system.
static napi_value rename_at(napi_env env, napi_callback_info info) {
  napi_value args[4];
  HANDLE parent = NULL, child = NULL;
  WCHAR from[NAME_BYTES], to[NAME_BYTES];
  DWORD from_length = 0, to_length = 0;
  size_t count = 4;
  bool replace = true;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count < 3 || count > 4 ||
      (count == 4 && napi_get_value_bool(env, args[3], &replace) != napi_ok))
    return fail(env, "EINVAL");
  const char *code = child_args(env, info, count, args, &parent, from, &from_length);
  if (!code && !read_name(env, args[2], to, &to_length)) code = "EINVAL";
  if (!code) code = open_child(parent, from, from_length, OPT_REPARSE, DELETE | SYNCHRONIZE,
      OPT_OPEN, &child);
  if (code) return fail(env, code);
  ULONG size = (ULONG)(sizeof(FILE_RENAME_INFO) + to_length * sizeof(WCHAR));
  FILE_RENAME_INFO *record = (FILE_RENAME_INFO *)calloc(1, size);
  if (record == NULL) code = "ENOMEM";
  else {
    record->ReplaceIfExists = replace ? TRUE : FALSE;
    record->RootDirectory = parent;
    record->FileNameLength = to_length * sizeof(WCHAR);
    memcpy(record->FileName, to, to_length * sizeof(WCHAR));
    IO_STATUS_T io;
    NTSTATUS_T status = nt_set(child, &io, record, size, 10UL);
    if (status < 0) code = code_of(nt_to_dos(status));
    free(record);
  }
  CloseHandle(child);
  return done(env, code);
}
// REPARSE_DATA_BUFFER's mount-point form (ntifs.h, not in the SDK's user-mode headers).
typedef struct {
  ULONG ReparseTag;
  USHORT ReparseDataLength, Reserved;
  USHORT SubstituteNameOffset, SubstituteNameLength, PrintNameOffset, PrintNameLength;
  WCHAR PathBuffer[1];
} MOUNT_POINT_T;
#define TARGET_CHARS 4000
// Makes `name` in the pinned parent a junction to the drive-absolute `target` (TypeScript checks
// it). The directory is created and opened in one handle-relative call, so the junction lands in
// the held folder even if that folder's path now leads elsewhere. On failure it is removed again
// through the same handle.
static napi_value junction_at(napi_env env, napi_callback_info info) {
  napi_value args[3];
  HANDLE parent = NULL, child = NULL;
  WCHAR name[NAME_BYTES], target[TARGET_CHARS];
  DWORD length = 0;
  char text[TARGET_CHARS * 3 + 1];
  size_t size = 0;
  const char *code = child_args(env, info, 3, args, &parent, name, &length);
  if (!code && (napi_get_value_string_utf8(env, args[2], text, sizeof(text), &size) != napi_ok ||
      size < 3 || size >= sizeof(text) - 1 || strlen(text) != size)) code = "EINVAL";
  int count = 0;
  if (!code) {
    count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)size, target, TARGET_CHARS);
    if (count < 3 || target[1] != L':' || target[2] != L'\\') code = "EINVAL";
  }
  if (!code) code = open_child(parent, name, length, OPT_DIRECTORY | OPT_REPARSE,
      FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
      OPT_CREATE, &child);
  if (code) return fail(env, code);
  // Substitute name `\??\X:\...` then print name `X:\...`, each NUL-terminated.
  USHORT target_bytes = (USHORT)(count * sizeof(WCHAR));
  USHORT substitute_bytes = (USHORT)(target_bytes + 4 * sizeof(WCHAR));
  USHORT path_bytes = (USHORT)(substitute_bytes + target_bytes + 2 * sizeof(WCHAR));
  DWORD total = (DWORD)(offsetof(MOUNT_POINT_T, PathBuffer) + path_bytes);
  MOUNT_POINT_T *point = (MOUNT_POINT_T *)calloc(1, total);
  if (point == NULL) code = "ENOMEM";
  else {
    point->ReparseTag = IO_REPARSE_TAG_MOUNT_POINT;
    point->ReparseDataLength = (USHORT)(total - offsetof(MOUNT_POINT_T, SubstituteNameOffset));
    point->SubstituteNameOffset = 0;
    point->SubstituteNameLength = substitute_bytes;
    point->PrintNameOffset = (USHORT)(substitute_bytes + sizeof(WCHAR));
    point->PrintNameLength = target_bytes;
    memcpy(point->PathBuffer, L"\\??\\", 4 * sizeof(WCHAR));
    memcpy(point->PathBuffer + 4, target, target_bytes);
    memcpy(point->PathBuffer + 4 + count + 1, target, target_bytes);
    DWORD returned = 0;
    if (!DeviceIoControl(child, FSCTL_SET_REPARSE_POINT, point, total, NULL, 0, &returned, NULL))
      code = last_error();
    free(point);
  }
  if (code) {
    FILE_DISPOSITION_INFO disposition = {TRUE};
    SetFileInformationByHandle(child, FileDispositionInfo, &disposition, sizeof(disposition));
  }
  CloseHandle(child);
  return done(env, code);
}
// Accepts only "X:\..." (TypeScript refuses UNC and device paths first), one component at a time.
static napi_value open_root(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t count = 1, size;
  char *path = NULL;
  const char *code = NULL;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      napi_get_value_string_utf8(env, args[0], NULL, 0, &size) != napi_ok || size < 3 || size > 32767 ||
      (path = (char *)malloc(size + 1)) == NULL) return fail(env, "EINVAL");
  napi_get_value_string_utf8(env, args[0], path, size + 1, &size);
  char drive = path[0];
  if (strlen(path) != size || !((drive >= 'A' && drive <= 'Z') || (drive >= 'a' && drive <= 'z')) ||
      path[1] != ':' || !is_separator(path[2])) { free(path); return fail(env, "EINVAL"); }
  WCHAR root[4] = {(WCHAR)drive, L':', L'\\', 0};
  HANDLE current = CreateFileW(root, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (current == INVALID_HANDLE_VALUE) code = last_error();
  if (!code) code = plain_directory(current);
  for (char *part = path + 3; !code && *part;) {
    char *end = part;
    while (*end && !is_separator(*end)) end++;
    if (end != part) {
      WCHAR name[NAME_BYTES];
      DWORD length;
      HANDLE next = NULL;
      code = wide_component(part, (size_t)(end - part), name, &length);
      if (!code) code = open_child(current, name, length, OPT_REPARSE, DIRECTORY_ACCESS, OPT_OPEN, &next);
      if (!code) { CloseHandle(current); current = next; code = plain_directory(current); }
    }
    part = *end ? end + 1 : end;
  }
  free(path);
  if (code) { if (current != INVALID_HANDLE_VALUE) CloseHandle(current); return fail(env, code); }
  return adopt(env, current);
}
// Raw facts for TypeScript: FILE_ID_INFO bytes, attributes, size and FILETIME ticks.
static napi_value describe(napi_env env, HANDLE handle) {
  FILE_ID_INFO id = {0};
  FILE_BASIC_INFO basic = {0};
  FILE_STANDARD_INFO standard = {0};
  DWORD attributes;
  const char *code = attributes_of(handle, &attributes);
  if (!code && (!GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id)) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard))))
    code = last_error();
  if (code) return fail(env, code);
  napi_value result, value;
  void *copy;
  napi_create_object(env, &result);
  napi_create_buffer_copy(env, sizeof(id), &id, &copy, &value);
  napi_set_named_property(env, result, "id", value);
  napi_create_uint32(env, attributes, &value);
  napi_set_named_property(env, result, "attributes", value);
  napi_create_double(env, (double)standard.EndOfFile.QuadPart, &value);
  napi_set_named_property(env, result, "size", value);
  napi_create_bigint_int64(env, basic.LastWriteTime.QuadPart, &value);
  napi_set_named_property(env, result, "writeTime", value);
  return result;
}
static napi_value stat_fd(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t count = 1;
  int32_t fd;
  HANDLE handle;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !read_int(env, args[0], 0, INT32_MAX, &fd)) return fail(env, "EINVAL");
  const char *code = borrow(fd, &handle);
  return code ? fail(env, code) : describe(env, handle);
}
// Lists at most `cap` names; one more is E2BIG. Every entry is bounds-checked. With `facts`,
// also returns each entry's attributes, size and write time from the same enumeration.
static napi_value list_names(napi_env env, napi_callback_info info, int facts) {
  napi_value args[2], result, value, attributes = NULL, sizes = NULL, times = NULL;
  size_t count = 2;
  int32_t fd, cap;
  HANDLE handle;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2 ||
      !read_int(env, args[0], 0, INT32_MAX, &fd) || !read_int(env, args[1], 1, 10000, &cap))
    return fail(env, "EINVAL");
  const char *code = borrow(fd, &handle);
  if (!code) code = plain_directory(handle);
  BYTE *batch = code ? NULL : (BYTE *)malloc(65536);
  if (!code && batch == NULL) code = "ENOMEM";
  if (code) return fail(env, code);
  size_t header = offsetof(FILE_ID_EXTD_DIR_INFO, FileName);
  uint32_t accepted = 0;
  napi_create_array(env, &result);
  if (facts) {
    napi_create_array(env, &attributes);
    napi_create_array(env, &sizes);
    napi_create_array(env, &times);
  }
  for (FILE_INFO_BY_HANDLE_CLASS kind = FileIdExtdDirectoryRestartInfo; !code;
       kind = FileIdExtdDirectoryInfo) {
    if (!GetFileInformationByHandleEx(handle, kind, batch, 65536)) {
      if (GetLastError() != ERROR_NO_MORE_FILES) code = last_error();
      break;
    }
    for (BYTE *entry = batch; !code;) {
      size_t remaining = (size_t)(batch + 65536 - entry);
      FILE_ID_EXTD_DIR_INFO *item = (FILE_ID_EXTD_DIR_INFO *)(void *)entry;
      if (remaining < header || item->FileNameLength == 0 || item->FileNameLength % 2 ||
          item->FileNameLength > remaining - header ||
          (item->NextEntryOffset && (item->NextEntryOffset < header + item->FileNameLength ||
              item->NextEntryOffset >= remaining))) { code = "EIO"; break; }
      int length = (int)(item->FileNameLength / 2);
      WCHAR *name = item->FileName;
      if (!(length == 1 && name[0] == L'.') && !(length == 2 && name[0] == L'.' && name[1] == L'.')) {
        char utf8[NAME_BYTES * 3];
        int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name, length, utf8,
            (int)sizeof(utf8), NULL, NULL);
        if (accepted >= (uint32_t)cap) code = "E2BIG";
        else if (size <= 0 || memchr(utf8, '\0', (size_t)size)) code = "EIO";
        else {
          napi_create_string_utf8(env, utf8, (size_t)size, &value);
          if (facts) {
            napi_value fact;
            napi_create_uint32(env, item->FileAttributes, &fact);
            napi_set_element(env, attributes, accepted, fact);
            napi_create_double(env, (double)item->EndOfFile.QuadPart, &fact);
            napi_set_element(env, sizes, accepted, fact);
            napi_create_bigint_int64(env, item->LastWriteTime.QuadPart, &fact);
            napi_set_element(env, times, accepted, fact);
          }
          napi_set_element(env, result, accepted++, value);
        }
      }
      if (!item->NextEntryOffset) break;
      entry += item->NextEntryOffset;
    }
  }
  free(batch);
  if (code) return fail(env, code);
  if (!facts) return result;
  napi_value listing;
  napi_create_object(env, &listing);
  napi_set_named_property(env, listing, "names", result);
  napi_set_named_property(env, listing, "attributes", attributes);
  napi_set_named_property(env, listing, "sizes", sizes);
  napi_set_named_property(env, listing, "writeTimes", times);
  return listing;
}
static napi_value names(napi_env env, napi_callback_info info) {
  return list_names(env, info, 0);
}
static napi_value names_with_facts(napi_env env, napi_callback_info info) {
  return list_names(env, info, 1);
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"openRoot", NULL, open_root, NULL, NULL, NULL, napi_default, NULL},
    {"openAt", NULL, open_at, NULL, NULL, NULL, napi_default, NULL},
    {"openMetadataAt", NULL, open_metadata_at, NULL, NULL, NULL, napi_default, NULL},
    {"createFileAt", NULL, create_file_at, NULL, NULL, NULL, napi_default, NULL},
    {"mkdirAt", NULL, mkdir_at, NULL, NULL, NULL, napi_default, NULL},
    {"unlinkAt", NULL, unlink_at, NULL, NULL, NULL, napi_default, NULL},
    {"removeDirectoryAt", NULL, remove_directory_at, NULL, NULL, NULL, napi_default, NULL},
    {"renameAt", NULL, rename_at, NULL, NULL, NULL, napi_default, NULL},
    {"junctionAt", NULL, junction_at, NULL, NULL, NULL, napi_default, NULL},
    {"statFd", NULL, stat_fd, NULL, NULL, NULL, napi_default, NULL},
    {"names", NULL, names, NULL, NULL, NULL, napi_default, NULL},
    {"namesWithFacts", NULL, names_with_facts, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
#endif
