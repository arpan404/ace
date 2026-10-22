// Single-component child opens for the Windows handle core.
//
// Primary sources: NtCreateFile RootDirectory semantics + reparse remarks
// (https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile),
// libuv fd bridge ownership (https://docs.libuv.org/en/v1.x/fs.html).
//
// Each op borrows the parent HANDLE via the single shared wcore_borrow_handle
// wrapper (thread-local invalid-parameter guard, see windows_core.h) — the
// fd must stay open for the call — and stores nothing. The parent fd itself
// stays a plain CRT fd owned by the Node side.
//
// DesiredAccess follows the NtCreateFile remarks: generic rights apply to
// files only, so directories use specific rights (FILE_LIST_DIRECTORY |
// FILE_READ_ATTRIBUTES | SYNCHRONIZE) while files use GENERIC_READ.
// SYNCHRONIZE is required with FILE_SYNCHRONOUS_IO_NONALERT.

#ifdef _WIN32
#include <windows.h>
#include <uv.h>
#include "windows_core.h"
#include <string.h>

static const char *bridge_to_fd(HANDLE handle, int *out_fd) {
  // uv_open_osfhandle consumes the HANDLE; Node close releases it via the
  // shared-UCRT fd table (requires /MD + node.lib; see build probe).
  int fd = uv_open_osfhandle((uv_os_fd_t)handle);
  if (fd < 0) {
    CloseHandle(handle);
    return "EMFILE";
  }
  *out_fd = fd;
  return NULL;
}

static const char *open_child(
    int parent_fd, const char *name, ULONG options, ACCESS_MASK access,
    int expect_dir, int *out_fd) {
  if (name == NULL || out_fd == NULL) return "EINVAL";
  HANDLE parent = NULL;
  const char *borrowed = wcore_borrow_handle(parent_fd, &parent);
  if (borrowed != NULL) return borrowed;
  size_t len = strlen(name);
  const char *valid = wcore_validate_component(name, len);
  if (valid != NULL) return valid;
  WCHAR wname[1024];
  DWORD wlen = 0;
  const char *conv = wcore_wide_from_utf8(name, len, wname, 1024, &wlen);
  if (conv != NULL) return conv;
  HANDLE child = NULL;
  const char *opened =
      wcore_nt_create_child(parent, wname, wlen, options, access, &child);
  if (opened != NULL) {
    // The OS reports a directory found by a file open as ERROR_DIRECTORY
    // (STATUS_FILE_IS_A_DIRECTORY maps alongside STATUS_NOT_A_DIRECTORY).
    // Surface POSIX EISDIR so file/dir misuse stays distinguishable.
    // VM-gated: adjust if a host mapping ever yields a different code.
    if (!expect_dir && strcmp(opened, "ENOTDIR") == 0) return "EISDIR";
    return opened;
  }
  // Fail closed on any reparse point: this core has no link-itself op, so a
  // symlink/junction/mount-point child is an escape (ELOOP), never followed.
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
  return bridge_to_fd(child, out_fd);
}

const char *wcore_open_dir_at(int parent_fd, const char *name, int *out_fd) {
  return open_child(parent_fd, name, WCORE_OPTS_DIR,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE, 1, out_fd);
}

const char *wcore_open_file_at(int parent_fd, const char *name, int *out_fd) {
  return open_child(parent_fd, name, WCORE_OPTS_FILE,
      GENERIC_READ | SYNCHRONIZE, 0, out_fd);
}
#endif
