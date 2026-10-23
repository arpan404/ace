// Atomic private-file creation for the Windows handle core.
//
// Exclusively creates one validated component relative to a pinned parent
// (FILE_CREATE: any existing name, including junctions and directories, is
// EEXIST with no mutation). The protected owner-only security descriptor
// (owner = current TokenUser SID, DACL = exactly one zero-flag
// FILE_ALL_ACCESS ACE for that owner) is installed in
// OBJECT_ATTRIBUTES.SecurityDescriptor at NtCreateFile creation, never
// repaired afterwards. The returned fd is verified with the shared
// checkPrivateFd logic; verification failure closes the fresh fd and never
// reopens or deletes by name. No WRITE_OWNER, no admin bypass, no
// ownership taking: current-user ownership is created, never seized.
//
// Primary sources (fresh, no other-project code):
// - NtCreateFile RootDirectory relative resolution, FILE_CREATE
//   disposition, CreateOptions values, SecurityDescriptor field:
//   Microsoft Learn "NtCreateFile function (ntifs.h)"
//   (https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile).
// - Absolute descriptor build: Microsoft Learn "InitializeSecurityDescriptor"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-initializesecuritydescriptor),
//   "SetSecurityDescriptorOwner function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-setsecuritydescriptorowner)
//   (owner, FALSE = not defaulted),
//   "SetSecurityDescriptorDacl function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-setsecuritydescriptordacl)
//   (TRUE present, FALSE not defaulted),
//   "SetSecurityDescriptorControl function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-setsecuritydescriptorcontrol)
//   (SE_DACL_PROTECTED set via interest+set masks).
// - Current user SID + owner-only ACL: shared helpers in private_security.c
//   (OpenProcessToken/GetTokenInformation(TokenUser), CopySid,
//   InitializeAcl/AddAccessAllowedAceEx, one zero-flag FILE_ALL_ACCESS ACE).
// - fd bridge ownership: libuv docs "Helper functions"
//   (https://docs.libuv.org/en/v1.x/fs.html) — uv_open_osfhandle consumes
//   the HANDLE (never CloseHandle after the call); failures close the
//   HANDLE here, verification failures close the fresh fd with
//   wcore_close_fd (Node libuv, never CloseHandle alone, never delete).
// - Component lexical rules: Microsoft Learn "Naming Files, Paths, and
//   Namespaces" (https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).
// - Error codes: Microsoft Learn "System Error Codes"
//   (https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes).
//
// No NAPI surface here; the parent layer decides any exposure. HANDLEs never
// cross NAPI; only the verified Node-owned fd is returned.

#ifdef _WIN32
// Win10 baseline (matches nt_bridge.c) so the security types resolve.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include "windows_core.h"

const char *wcore_create_private_file_at(int parent_fd, const char *name, int *out_fd) {
  if (name == NULL || out_fd == NULL) return "EINVAL";
  HANDLE parent = NULL;
  const char *borrowed = wcore_borrow_handle(parent_fd, &parent);
  if (borrowed != NULL) return borrowed;
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
  if (verdict == NULL) verdict = wcore_owner_only_acl(user, &acl);
  SECURITY_DESCRIPTOR sd;
  if (verdict == NULL && !InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION)) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    verdict = mapped != NULL ? mapped : "EIO";
  }
  // Owner is created, never taken: FALSE marks it explicitly set, and
  // WRITE_OWNER is never requested anywhere on this path.
  if (verdict == NULL && !SetSecurityDescriptorOwner(&sd, user, FALSE)) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    verdict = mapped != NULL ? mapped : "EIO";
  }
  if (verdict == NULL && !SetSecurityDescriptorDacl(&sd, TRUE, acl, FALSE)) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    verdict = mapped != NULL ? mapped : "EIO";
  }
  // Protect the DACL from inheritance: interest and set masks both carry
  // SE_DACL_PROTECTED so only that bit is changed.
  if (verdict == NULL &&
      !SetSecurityDescriptorControl(&sd, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    verdict = mapped != NULL ? mapped : "EIO";
  }
  if (verdict == NULL) {
    // Exclusive regular-file creation with the private descriptor captured
    // at creation time. FILE_CREATE fails closed on any existing name
    // (the bridge maps directory/reparse type refusals to EEXIST); nothing
    // is opened, truncated, or retagged on collision.
    verdict = wcore_nt_create_new_child_sd(parent, wname, wlen, WCORE_OPTS_FILE,
        GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE, &sd, &child);
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
  int fd = -1;
  const char *bridged = wcore_adopt_handle(child, &fd);
  if (bridged != NULL) return bridged;
  // Verify the actual returned fd, never by name. On failure close the
  // fresh fd through Node libuv and report the check verdict; the file is
  // left in place (never reopened, never deleted here).
  const char *checked = wcore_check_private_fd(fd);
  if (checked != NULL) {
    (void)wcore_close_fd(fd);
    return checked;
  }
  *out_fd = fd;
  return NULL;
}
#endif
