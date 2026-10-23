// Private-file ACL check and owner-only secure for the Windows handle core.
//
// checkPrivateAt fails closed unless the named child is a regular file with
// exactly one hard link, owned by the current process user, guarded by a
// protected owner-only DACL: exactly one ACCESS_ALLOWED_ACE with zero flags
// and a FILE_ALL_ACCESS mask for that same owner SID. Any reparse point is
// ELOOP, directories are EISDIR, hardlinks and every DACL/owner mismatch
// are EACCES. There is no uid-0/admin bypass on Windows: ownership is
// owner-SID equality against the current process TokenUser only.
//
// securePrivateAt opens the same validated child with WRITE_DAC (never
// WRITE_OWNER: current-user ownership is a precondition, never taken),
// requires the same regular single-link shape, installs the exact
// owner-only protected DACL, then re-reads the SAME handle through the
// shared check logic before reporting success.
//
// Primary sources (fresh, no other-project code):
// - NtCreateFile RootDirectory relative resolution + OPEN_REPARSE_POINT:
//   Microsoft Learn "NtCreateFile function (ntifs.h)"
//   (https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile).
// - Owner/DACL read: Microsoft Learn "GetSecurityInfo function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)
//   (SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
//   the returned descriptor is released with LocalFree).
// - DACL/ACE model: Microsoft Learn "DACLs and ACEs"
//   (https://learn.microsoft.com/en-us/windows/win32/secauthz/dacls-and-aces),
//   "ACCESS_ALLOWED_ACE structure"
//   (https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-access_allowed_ace),
//   "ACL structure"
//   (https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-acl).
// - SID equality: Microsoft Learn "EqualSid function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-equalsid).
// - Current user: Microsoft Learn "OpenProcessToken function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken)
//   and "GetTokenInformation function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation)
//   (TokenUser).
// - Link count / directory class: Microsoft Learn
//   "GetFileInformationByHandleEx function" + "FILE_STANDARD_INFO structure"
//   (https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex).
// - Error codes: Microsoft Learn "System Error Codes"
//   (https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes).
// - DACL install: Microsoft Learn "SetSecurityInfo function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)
//   (DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION; the
//   owner is untouched: no OWNER_SECURITY_INFORMATION, NULL owner/group).
// - ACL build: Microsoft Learn "InitializeAcl function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-initializeacl)
//   and "AddAccessAllowedAceEx function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-addaccessallowedaceex)
//   (one zero-flag ACCESS_ALLOWED_ACE, FILE_ALL_ACCESS, owner SID).
// - SID copy: Microsoft Learn "CopySid function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-copysid).
//
// Helpers are file-static but factored by responsibility (open, type/link,
// DACL shape, current-user SID load/equality, shared security verdict) so
// check and secure reuse the same owner/ACL logic. No addon CRT fd calls:
// the subject HANDLE is closed with CloseHandle, security descriptors with
// LocalFree, SID/ACL buffers with free, token state with CloseHandle.

#ifdef _WIN32
// Win10 baseline (matches nt_bridge.c) so FILE_STANDARD_INFO and the
// FileStandardInfo class are declared.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <aclapi.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include "windows_core.h"

// Open one validated component without any DIRECTORY or NON_DIRECTORY type
// constraint, so reparse points and directories can be identified explicitly
// instead of surfacing as NT type-status refusals. OPEN_REPARSE_POINT keeps
// the open on the link itself. The caller picks `access`: the checker reads
// owner/DACL with READ_CONTROL, the setter additionally needs WRITE_DAC.
static const char *private_open_subject(
    HANDLE parent, const char *name, ACCESS_MASK access, HANDLE *out) {
  if (name == NULL || out == NULL) return "EINVAL";
  size_t len = strlen(name);
  const char *valid = wcore_validate_component(name, len);
  if (valid != NULL) return valid;
  WCHAR wname[1024];
  DWORD wlen = 0;
  const char *conv = wcore_wide_from_utf8(name, len, wname, 1024, &wlen);
  if (conv != NULL) return conv;
  return wcore_nt_create_child(parent, wname, wlen,
      WCORE_FILE_SYNCHRONOUS_IO_NONALERT | WCORE_FILE_OPEN_REPARSE_POINT,
      access, out);
}

// Reject links, directories and hardlinks before any security read.
// Reparse points are ELOOP, directories EISDIR, hardlinks EACCES.
static const char *private_assert_regular_single_link(HANDLE child) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  memset(&tag, 0, sizeof(tag));
  if (!GetFileInformationByHandleEx(
          child, FileAttributeTagInfo, &tag, sizeof(tag))) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  if (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return "ELOOP";
  if (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) return "EISDIR";
  FILE_STANDARD_INFO stdinfo;
  memset(&stdinfo, 0, sizeof(stdinfo));
  if (!GetFileInformationByHandleEx(
          child, FileStandardInfo, &stdinfo, sizeof(stdinfo))) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  if (stdinfo.Directory) return "EISDIR";
  if (stdinfo.NumberOfLinks != 1) return "EACCES";
  return NULL;
}

// Require a protected DACL carrying exactly one zero-flag
// ACCESS_ALLOWED_ACE with a FILE_ALL_ACCESS mask for the owner SID.
// Any inherited/other-user ACE shape is EACCES; only Win32 API failures
// map through wcore_dos_to_code.
static const char *private_assert_owner_only_dacl(
    PACL dacl, SECURITY_DESCRIPTOR_CONTROL control, PSID owner) {
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
  if (header->AceFlags != 0) return "EACCES";
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

// Load a malloc'd copy of the current process TokenUser SID; the caller
// frees it. No well-known-admin or privilege bypass: the copy is only ever
// compared with EqualSid or installed as the single owner ACE.
static const char *private_load_current_user_sid(PSID *out) {
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

// Require the file owner SID to equal the current process TokenUser SID.
// No well-known-admin or privilege bypass: equality only.
static const char *private_assert_owner_is_current_user(PSID owner) {
  if (owner == NULL || !IsValidSid(owner)) return "EACCES";
  PSID user = NULL;
  const char *loaded = private_load_current_user_sid(&user);
  if (loaded != NULL) return loaded;
  const char *verdict = EqualSid(owner, user) ? NULL : "EACCES";
  free(user);
  return verdict;
}

// Shared verdict on an open child HANDLE: read owner/DACL, then apply the
// owner-only protected-DACL shape and TokenUser ownership checks. The
// descriptor is LocalFree'd here; the caller still owns the HANDLE.
static const char *private_verify_security(HANDLE child) {
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
    verdict = private_assert_owner_only_dacl(dacl, control, owner);
    if (verdict == NULL)
      verdict = private_assert_owner_is_current_user(owner);
  }
  LocalFree(descriptor);
  return verdict;
}

const char *wcore_check_private_at(int parent_fd, const char *name) {
  if (name == NULL) return "EINVAL";
  HANDLE parent = NULL;
  const char *borrowed = wcore_borrow_handle(parent_fd, &parent);
  if (borrowed != NULL) return borrowed;
  const char *parent_type = wcore_assert_dir_noreparse(parent);
  if (parent_type != NULL) return parent_type;
  HANDLE child = NULL;
  const char *opened = private_open_subject(parent, name,
      READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &child);
  if (opened != NULL) return opened;
  const char *shape = private_assert_regular_single_link(child);
  if (shape != NULL) {
    CloseHandle(child);
    return shape;
  }
  const char *verdict = private_verify_security(child);
  // A CloseHandle failure is only reported when the verdict was success.
  if (!CloseHandle(child) && verdict == NULL) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    verdict = mapped != NULL ? mapped : "EIO";
  }
  return verdict;
}

const char *wcore_secure_private_at(int parent_fd, const char *name) {
  if (name == NULL) return "EINVAL";
  HANDLE parent = NULL;
  const char *borrowed = wcore_borrow_handle(parent_fd, &parent);
  if (borrowed != NULL) return borrowed;
  const char *parent_type = wcore_assert_dir_noreparse(parent);
  if (parent_type != NULL) return parent_type;
  HANDLE child = NULL;
  // WRITE_DAC authorizes the DACL replacement below. WRITE_OWNER is never
  // requested: current-user ownership is a precondition, never taken, and
  // there is no admin bypass.
  const char *opened = private_open_subject(parent, name,
      READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &child);
  if (opened != NULL) return opened;
  const char *verdict = private_assert_regular_single_link(child);
  PSID user = NULL;
  PACL acl = NULL;
  if (verdict == NULL) verdict = private_load_current_user_sid(&user);
  if (verdict == NULL) {
    PSID owner = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    DWORD status = GetSecurityInfo(child, SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION, &owner, NULL, NULL, NULL, &descriptor);
    if (status != ERROR_SUCCESS) {
      const char *code = wcore_dos_to_code(status);
      verdict = code != NULL ? code : "EIO";
    } else {
      if (owner == NULL || !IsValidSid(owner) || !EqualSid(owner, user)) verdict = "EACCES";
      LocalFree(descriptor);
    }
  }
  if (verdict == NULL) {
    // Exact owner-only DACL: one zero-flag ACCESS_ALLOWED_ACE with a
    // FILE_ALL_ACCESS mask for the owner SID. SID sizes are bounded
    // (SECURITY_MAX_SID_SIZE), so the ACL length cannot overflow.
    DWORD acl_len = (DWORD)(sizeof(ACL) +
        offsetof(ACCESS_ALLOWED_ACE, SidStart) + GetLengthSid(user));
    acl = (PACL)malloc(acl_len);
    if (acl == NULL) {
      verdict = "ENOMEM";
    } else if (!InitializeAcl(acl, acl_len, ACL_REVISION)) {
      const char *mapped = wcore_dos_to_code(GetLastError());
      verdict = mapped != NULL ? mapped : "EIO";
    } else if (!AddAccessAllowedAceEx(
        acl, ACL_REVISION, 0, FILE_ALL_ACCESS, user)) {
      const char *mapped = wcore_dos_to_code(GetLastError());
      verdict = mapped != NULL ? mapped : "EIO";
    } else {
      // DACL-only replacement, protected from inheritance. The owner is
      // left untouched: NULL owner/group and no OWNER_SECURITY_INFORMATION.
      DWORD set_status = SetSecurityInfo(child, SE_FILE_OBJECT,
          DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
          NULL, NULL, acl, NULL);
      if (set_status != ERROR_SUCCESS) {
        const char *mapped = wcore_dos_to_code(set_status);
        verdict = mapped != NULL ? mapped : "EIO";
      } else {
        // Re-read the SAME handle through the shared checker logic: only
        // an observed owner-only protected DACL is success.
        verdict = private_assert_regular_single_link(child);
        if (verdict == NULL) verdict = private_verify_security(child);
      }
    }
  }
  if (user != NULL) free(user);
  if (acl != NULL) free(acl);
  // A CloseHandle failure is only reported when the verdict was success.
  if (!CloseHandle(child) && verdict == NULL) {
    const char *mapped = wcore_dos_to_code(GetLastError());
    verdict = mapped != NULL ? mapped : "EIO";
  }
  return verdict;
}
#endif
