// Single-component child opens for the Windows handle core.
//
// Primary sources: NtCreateFile RootDirectory semantics + reparse remarks
// (https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile),
// libuv fd bridge ownership (https://docs.libuv.org/en/v1.x/fs.html).
//
// Each op borrows the parent HANDLE via the single shared wcore_borrow_handle
// wrapper (Node libuv fd validation, see windows_core.h) — the
// fd must stay open for the call — and stores nothing. The parent fd itself
// stays a plain fd owned by Node's libuv.
//
// DesiredAccess follows the NtCreateFile remarks: generic rights apply to
// files only, so directories use specific rights (FILE_LIST_DIRECTORY |
// FILE_READ_ATTRIBUTES | SYNCHRONIZE) while files use GENERIC_READ.
// SYNCHRONIZE is required with FILE_SYNCHRONOUS_IO_NONALERT. The metadata
// open below is the link-itself op: it carries only FILE_READ_ATTRIBUTES |
// SYNCHRONIZE and returns files, directories and reparse points without
// following them.

#ifdef _WIN32
#include <windows.h>
#include "windows_core.h"
#include <string.h>

typedef const char *(*child_opener)(HANDLE, const WCHAR *, DWORD, ULONG,
    ACCESS_MASK, HANDLE *);

static const char *acquire_child_handle(
    int parent_fd, const char *name, ULONG options, ACCESS_MASK access,
    child_opener open, HANDLE *out) {
  if (name == NULL || out == NULL) return "EINVAL";
  HANDLE parent = NULL;
  const char *borrowed = wcore_borrow_handle(parent_fd, &parent);
  if (borrowed != NULL) return borrowed;
  const char *directory = wcore_assert_dir_noreparse(parent);
  if (directory != NULL) return directory;
  size_t len = strlen(name);
  const char *valid = wcore_validate_component(name, len);
  if (valid != NULL) return valid;
  WCHAR wname[1024];
  DWORD wlen = 0;
  const char *conv = wcore_wide_from_utf8(name, len, wname, 1024, &wlen);
  if (conv != NULL) return conv;
  return open(parent, wname, wlen, options, access, out);
}

static const char *open_child(
    int parent_fd, const char *name, ULONG options, ACCESS_MASK access,
    int expect_dir, child_opener open, int *out_fd) {
  if (out_fd == NULL) return "EINVAL";
  HANDLE child = NULL;
  const char *opened =
      acquire_child_handle(parent_fd, name, options, access, open, &child);
  if (opened != NULL) return opened;
  // Data opens fail closed on any reparse point: a symlink/junction/
  // mount-point child is an escape (ELOOP), never followed. The metadata
  // open below is the only link-itself op and bypasses this assertion.
  const char *reparse = wcore_assert_noreparse(child);
  if (reparse != NULL) {
    CloseHandle(child);
    return reparse;
  }
  FILE_ATTRIBUTE_TAG_INFO info;
  memset(&info, 0, sizeof(info));
  if (!GetFileInformationByHandleEx(
          child, FileAttributeTagInfo, &info, sizeof(info))) {
    const char *code = wcore_dos_to_code(GetLastError());
    CloseHandle(child);
    return code != NULL ? code : "EIO";
  }
  int is_dir = (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (expect_dir && !is_dir) {
    CloseHandle(child);
    return "ENOTDIR";
  }
  if (!expect_dir && is_dir) {
    CloseHandle(child);
    return "EISDIR";
  }
  return wcore_adopt_handle(child, out_fd);
}

const char *wcore_open_dir_at(int parent_fd, const char *name, int *out_fd) {
  return open_child(parent_fd, name, WCORE_OPTS_DIR,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, 1,
      wcore_nt_create_child, out_fd);
}

const char *wcore_open_file_at(int parent_fd, const char *name, int *out_fd) {
  return open_child(parent_fd, name, WCORE_OPTS_FILE,
      GENERIC_READ | SYNCHRONIZE, 0, wcore_nt_create_child, out_fd);
}

const char *wcore_open_metadata_at(int parent_fd, const char *name, int *out_fd) {
  if (out_fd == NULL) return "EINVAL";
  HANDLE child = NULL;
  const char *opened = acquire_child_handle(parent_fd, name,
      WCORE_FILE_SYNCHRONOUS_IO_NONALERT | WCORE_FILE_OPEN_REPARSE_POINT,
      FILE_READ_ATTRIBUTES | SYNCHRONIZE, wcore_nt_create_child, &child);
  if (opened != NULL) return opened;
  return wcore_adopt_handle(child, out_fd);
}

const char *wcore_create_file_at(int parent_fd, const char *name, int *out_fd) {
  return open_child(parent_fd, name, WCORE_OPTS_FILE,
      GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE, 0,
      wcore_nt_create_new_child, out_fd);
}

const char *wcore_mkdir_at(int parent_fd, const char *name) {
  int fd = -1;
  const char *code = open_child(parent_fd, name, WCORE_OPTS_DIR,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, 1,
      wcore_nt_create_new_child, &fd);
  if (code != NULL) return code;
  return wcore_close_fd(fd);
}
#endif
