// Atomic private-directory creation and same-object ACL observation.
// The creation SD sets the TokenUser owner and a protected owner-only DACL
// with child-inheritance flags. Existing names are refused without repair.
// The checker acquires READ_CONTROL through ReOpenFile on the caller-held
// object, never a pathname; it closes only its owned security-query handle.
// There is no ACL setter that could propagate changes through an existing tree.
//
// Primary contracts:
// https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile
// https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-reopenfile
// https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
// https://docs.libuv.org/en/v1.x/fs.html

#ifdef _WIN32
// Win10 baseline (matches nt_bridge.c) so the security and ReOpenFile
// declarations resolve.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <stddef.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "windows_core.h"

const char *wcore_check_private_directory_fd(int fd) {
  HANDLE borrowed = NULL;
  const char *loan = wcore_borrow_handle(fd, &borrowed);
  if (loan != NULL) return loan;
  const char *pinned = wcore_assert_dir_noreparse(borrowed);
  if (pinned != NULL) return pinned;
  // Same object, never by name: the borrowed directory fd may lack
  // READ_CONTROL (list-only opens), so reopen for the security read while
  // keeping backup + no-follow semantics for the directory itself.
  HANDLE owned = ReOpenFile(borrowed,
      READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
  if (owned == NULL || owned == INVALID_HANDLE_VALUE) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    return mapped != NULL ? mapped : "EIO";
  }
  const char *verdict = wcore_assert_dir_noreparse(owned);
  if (verdict == NULL) verdict = wcore_verify_private_directory_security(owned);
  // The owned reopen is always closed; the borrowed fd stays with the caller.
  // A close failure matters only when the verdict was success.
  if (!CloseHandle(owned) && verdict == NULL) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    verdict = mapped != NULL ? mapped : "EIO";
  }
  return verdict;
}

const char *wcore_create_private_directory_at(int parent_fd, const char *name, int *out_fd) {
  if (name == NULL || out_fd == NULL) return "EINVAL";
  HANDLE parent = NULL;
  const char *loan = wcore_borrow_handle(parent_fd, &parent);
  if (loan != NULL) return loan;
  const char *parent_type = wcore_assert_dir_noreparse(parent);
  if (parent_type != NULL) return parent_type;
  size_t len = strlen(name);
  const char *valid = wcore_validate_component(name, len);
  if (valid != NULL) return valid;
  WCHAR wname[1024];
  DWORD wlen = 0;
  const char *conv = wcore_wide_from_utf8(name, len, wname, 1024, &wlen);
  if (conv != NULL) return conv;
  PSID user = NULL;
  PACL acl = NULL;
  HANDLE child = NULL;
  const char *verdict = wcore_current_user_sid(&user);
  if (verdict == NULL) verdict = wcore_owner_directory_acl(user, &acl);
  SECURITY_DESCRIPTOR sd;
  if (verdict == NULL) verdict = wcore_init_private_descriptor(user, acl, &sd);
  if (verdict == NULL) {
    // Exclusive directory creation with the private descriptor captured at
    // creation time. FILE_CREATE fails closed on any existing name (the
    // bridge maps directory/reparse type refusals to EEXIST); nothing is
    // opened, truncated, or retagged on collision.
    verdict = wcore_nt_create_new_child_sd(parent, wname, wlen, WCORE_OPTS_DIR,
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
        &sd, &child);
  }
  // The kernel captured the descriptor at creation; the SID/ACL copies are
  // no longer needed on either path.
  if (user != NULL) {
    free(user);
    user = NULL;
  }
  if (acl != NULL) {
    free(acl);
    acl = NULL;
  }
  if (verdict != NULL) return verdict;
  // Verify the actual fresh child before adoption: owned directory shape
  // plus the shared protected owner-only directory verdict.
  const char *shape = wcore_assert_dir_noreparse(child);
  if (shape == NULL) shape = wcore_verify_private_directory_security(child);
  if (shape != NULL) {
    fprintf(stderr, "[DEBUG-private-dir] initial security verdict=%s\n", shape);
    CloseHandle(child);
    return shape;
  }
  int fd = -1;
  const char *bridged = wcore_adopt_handle(child, &fd);
  if (bridged != NULL) return bridged;
  // Re-verify the adopted fd through the same-object checker; on failure
  // close the fresh fd through Node libuv and leave the name in place
  // (never reopened, never deleted here).
  const char *checked = wcore_check_private_directory_fd(fd);
  if (checked != NULL) {
    fprintf(stderr, "[DEBUG-private-dir] adopted security verdict=%s\n", checked);
    (void)wcore_close_fd(fd);
    return checked;
  }
  *out_fd = fd;
  return NULL;
}
#endif
