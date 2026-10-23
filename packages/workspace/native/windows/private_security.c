// Shared private-security helpers for the Windows handle core.
//
// Loads the current process TokenUser SID and builds an ACL with one
// zero-flag FILE_ALL_ACCESS allow for that SID. Callers own the returned
// allocations and apply the security descriptor to their target.
//
// Primary sources (same as the callers, no other-project code):
// - Current user: Microsoft Learn "OpenProcessToken function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken)
//   and "GetTokenInformation function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation)
//   (TokenUser).
// - SID copy: Microsoft Learn "CopySid function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-copysid).
// - ACL build: Microsoft Learn "InitializeAcl function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-initializeacl)
//   and "AddAccessAllowedAceEx function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-addaccessallowedaceex)
//   (one zero-flag ACCESS_ALLOWED_ACE, FILE_ALL_ACCESS, owner SID).

#ifdef _WIN32
// Win10 baseline (matches nt_bridge.c) so the security types resolve.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <aclapi.h>
#include <stddef.h>
#include <stdlib.h>
#include "windows_core.h"

// Load a malloc'd copy of the current process TokenUser SID. On success
// stores the copy in *out and the caller frees it with free(). On failure
// stores NULL in *out and returns a static POSIX code string. No
// well-known-admin or privilege bypass: the copy is only ever compared with
// EqualSid or installed as the single owner ACE.
const char *wcore_current_user_sid(PSID *out) {
  if (out == NULL) return "EINVAL";
  *out = NULL;
  HANDLE token = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  DWORD needed = 0;
  // Size probe: the expected failure is ERROR_INSUFFICIENT_BUFFER with
  // the required byte count in `needed`.
  GetTokenInformation(token, TokenUser, NULL, 0, &needed);
  const char *code = NULL;
  BYTE *buffer = NULL;
  PSID copy = NULL;
  if (needed == 0) {
    code = "EIO";
  } else {
    buffer = (BYTE *)malloc(needed);
    if (buffer == NULL) {
      code = "ENOMEM";
    } else {
      DWORD got = 0;
      if (!GetTokenInformation(token, TokenUser, buffer, needed, &got)) {
        const char *mapped = wcore_dos_to_code(GetLastError());
        code = mapped != NULL ? mapped : "EIO";
      } else {
        TOKEN_USER *user = (TOKEN_USER *)(void *)buffer;
        if (user->User.Sid == NULL || !IsValidSid(user->User.Sid)) {
          code = "EACCES";
        } else {
          DWORD sid_len = GetLengthSid(user->User.Sid);
          copy = (PSID)malloc(sid_len);
          if (copy == NULL) {
            code = "ENOMEM";
          } else if (!CopySid(sid_len, copy, user->User.Sid)) {
            const char *mapped = wcore_dos_to_code(GetLastError());
            code = mapped != NULL ? mapped : "EIO";
            free(copy);
            copy = NULL;
          }
        }
      }
      free(buffer);
    }
  }
  CloseHandle(token);
  if (code != NULL) {
    if (copy != NULL) free(copy);
    return code;
  }
  *out = copy;
  return NULL;
}

// Build a malloc'd owner-only ACL: exactly one zero-flag
// ACCESS_ALLOWED_ACE with a FILE_ALL_ACCESS mask for `user`. On success
// stores the ACL in *out and the caller frees it with free(). On failure
// stores NULL in *out and returns a static POSIX code string. SID sizes
// are bounded (SECURITY_MAX_SID_SIZE), so the ACL length cannot overflow.
const char *wcore_owner_only_acl(PSID user, PACL *out) {
  if (out == NULL) return "EINVAL";
  *out = NULL;
  if (user == NULL || !IsValidSid(user)) return "EACCES";
  DWORD acl_len = (DWORD)(sizeof(ACL) +
      offsetof(ACCESS_ALLOWED_ACE, SidStart) + GetLengthSid(user));
  PACL acl = (PACL)malloc(acl_len);
  if (acl == NULL) return "ENOMEM";
  if (!InitializeAcl(acl, acl_len, ACL_REVISION)) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    const char *code = mapped != NULL ? mapped : "EIO";
    free(acl);
    return code;
  }
  if (!AddAccessAllowedAceEx(acl, ACL_REVISION, 0, FILE_ALL_ACCESS, user)) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    const char *code = mapped != NULL ? mapped : "EIO";
    free(acl);
    return code;
  }
  *out = acl;
  return NULL;
}
#endif
