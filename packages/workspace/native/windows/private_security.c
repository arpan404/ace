// Shared private-security helpers for the Windows handle core.
//
// Loads the current process TokenUser SID, builds owner-only ACLs, and
// verifies the strict owner-only protected-DACL shape on an open HANDLE.
// File ACLs carry one zero-flag FILE_ALL_ACCESS allow; directory ACLs
// carry OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE. Callers own the
// returned allocations and apply the security descriptor to their target.
// Shape (regular/directory/link) checks stay with the callers; this unit
// owns only the TokenUser ownership + protected-DACL + single-ACE verdict
// (no admin bypass, Win32 failures map via wcore_dos_to_code).
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

// Initialize an absolute protected security descriptor from caller-owned SID
// and ACL allocations. The kernel captures it during exclusive creation.
const char *wcore_init_private_descriptor(
    PSID user, PACL acl, SECURITY_DESCRIPTOR *out) {
  if (out == NULL) return "EINVAL";
  if (!InitializeSecurityDescriptor(out, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(out, user, FALSE) ||
      !SetSecurityDescriptorDacl(out, TRUE, acl, FALSE) ||
      !SetSecurityDescriptorControl(out, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    return mapped != NULL ? mapped : "EIO";
  }
  return NULL;
}

// Build a malloc'd owner ACL with one FILE_ALL_ACCESS allow carrying
// `flags`. On success stores the ACL in *out and the caller frees it with
// free(). On failure stores NULL in *out and returns a static POSIX code
// string. SID sizes are bounded (SECURITY_MAX_SID_SIZE), so the ACL length
// cannot overflow.
static const char *security_build_owner_acl(PSID user, BYTE flags, PACL *out) {
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
  if (!AddAccessAllowedAceEx(acl, ACL_REVISION, flags, FILE_ALL_ACCESS, user)) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    const char *code = mapped != NULL ? mapped : "EIO";
    free(acl);
    return code;
  }
  *out = acl;
  return NULL;
}

// Build a malloc'd owner-only ACL: exactly one zero-flag
// ACCESS_ALLOWED_ACE with a FILE_ALL_ACCESS mask for `user`. On success
// stores the ACL in *out and the caller frees it with free(). On failure
// stores NULL in *out and returns a static POSIX code string.
const char *wcore_owner_only_acl(PSID user, PACL *out) {
  return security_build_owner_acl(user, 0, out);
}

// Build a malloc'd owner-only directory ACL: exactly one
// ACCESS_ALLOWED_ACE with FILE_ALL_ACCESS for `user` carrying
// OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE so children inherit the
// owner-only shape. Same ownership/cleanup contract as wcore_owner_only_acl.
const char *wcore_owner_directory_acl(PSID user, PACL *out) {
  return security_build_owner_acl(user,
      OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE, out);
}

// Require a protected DACL carrying exactly one ACCESS_ALLOWED_ACE with
// `expected_flags` and a FILE_ALL_ACCESS mask for the owner SID. Any
// inherited/other-user ACE shape is EACCES; only Win32 API failures map
// through wcore_dos_to_code.
static const char *security_assert_owner_dacl(
    PACL dacl, SECURITY_DESCRIPTOR_CONTROL control, PSID owner,
    BYTE expected_flags) {
  if (dacl == NULL || owner == NULL || !IsValidSid(owner)) return "EACCES";
  if (!(control & SE_DACL_PRESENT)) return "EACCES";
  if (!(control & SE_DACL_PROTECTED)) return "EACCES";
  if (!IsValidAcl(dacl)) return "EACCES";
  if (dacl->AceCount != 1) return "EACCES";
  ACE_HEADER *header = NULL;
  if (!GetAce(dacl, 0, (void **)&header)) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  if (header == NULL) return "EIO";
  if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) return "EACCES";
  if (header->AceFlags != expected_flags) return "EACCES";
  size_t sid_offset = offsetof(ACCESS_ALLOWED_ACE, SidStart);
  if (header->AceSize < sid_offset + GetSidLengthRequired(0)) return "EACCES";
  ACCESS_ALLOWED_ACE *allow = (ACCESS_ALLOWED_ACE *)(void *)header;
  if (allow->Mask != FILE_ALL_ACCESS) return "EACCES";
  PSID ace_sid = (PSID)&allow->SidStart;
  if (GetSidLengthRequired(*GetSidSubAuthorityCount(ace_sid)) >
      header->AceSize - sid_offset || !IsValidSid(ace_sid)) return "EACCES";
  if (!EqualSid(ace_sid, owner)) return "EACCES";
  return NULL;
}

// Require the owner SID to equal the current process TokenUser SID. No
// well-known-admin or privilege bypass: equality only.
const char *wcore_assert_current_owner(PSID owner) {
  if (owner == NULL || !IsValidSid(owner)) return "EACCES";
  PSID user = NULL;
  const char *loaded = wcore_current_user_sid(&user);
  if (loaded != NULL) return loaded;
  const char *verdict = EqualSid(owner, user) ? NULL : "EACCES";
  free(user);
  return verdict;
}

// Shared verdict on an open HANDLE: read owner/DACL, then apply the
// owner-only protected-DACL shape (single FILE_ALL_ACCESS allow with
// `expected_flags`) and TokenUser ownership checks. The descriptor is
// LocalFree'd here; the caller still owns the HANDLE.
static const char *security_verify_handle(HANDLE child, BYTE expected_flags) {
  PSID owner = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD status = GetSecurityInfo(child, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL,
      &dacl, NULL, &descriptor);
  if (status != ERROR_SUCCESS) {
    const char *code = wcore_dos_to_code(status);
    return code != NULL ? code : "EIO";
  }
  // owner/dacl point inside descriptor: only descriptor is freed.
  const char *verdict = NULL;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision)) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    verdict = mapped != NULL ? mapped : "EIO";
  } else {
    verdict = security_assert_owner_dacl(dacl, control, owner, expected_flags);
    if (verdict == NULL)
      verdict = wcore_assert_current_owner(owner);
  }
  LocalFree(descriptor);
  return verdict;
}

// Verify an open file HANDLE: protected DACL with exactly one zero-flag
// FILE_ALL_ACCESS allow for the current TokenUser owner. No admin bypass.
const char *wcore_verify_private_file_security(HANDLE child) {
  return security_verify_handle(child, 0);
}

// Verify an open directory HANDLE: protected DACL with exactly one
// FILE_ALL_ACCESS allow for the current TokenUser owner carrying
// OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE. No admin bypass.
const char *wcore_verify_private_directory_security(HANDLE child) {
  return security_verify_handle(child,
      OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE);
}
#endif
