// openRoot for the Windows handle core: volume-anchored component walk.
//
// Primary sources:
// - Volume prefixes (drive "C:\", UNC "\\server\share") and the "\\?\"
//   / "\\.\" / NT-namespace rules: Microsoft Learn "Naming Files, Paths, and
//   Namespaces" (https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).
// - RootDirectory relative resolution + reparse remarks: Microsoft Learn
//   "NtCreateFile function (ntifs.h)"
//   (https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile).
// - Volume-root anchor: CreateFileW with FILE_FLAG_BACKUP_SEMANTICS (required
//   to open a directory) + FILE_FLAG_OPEN_REPARSE_POINT (never follow the
//   anchor itself); NULL security attributes => non-inheritable handle.
// - fd bridge ownership: libuv docs (https://docs.libuv.org/en/v1.x/fs.html):
//   uv_open_osfhandle consumes the HANDLE; the fd closes with Node close.
//
// Safety shape (never absolute child path joins):
// - The only absolute path ever opened is the 3-char volume root "X:\"
//   itself. Every deeper component is opened with
//   NtCreateFile(RootDirectory=parent, one validated component), so an
//   ancestor rename/symlink swap between steps cannot redirect the walk past
//   the per-step directory + not-reparse assertion.
// - First cut refuses UNC roots with ENOTSUP (explicit limitation, no silent
//   fallback) and rejects "\\?\" / "\\.\" / "\??\" caller inputs with EINVAL.
//
// Ancestor race note: each step opens with FILE_OPEN_REPARSE_POINT and then
// asserts directory + not-reparse before descending, so a link swapped in at
// any step fails closed with ELOOP. Callers pin the returned fd and verify
// identityOf before use.

#ifdef _WIN32
#include <windows.h>
#include <uv.h>
#include "windows_core.h"
#include <string.h>

// NT path ceiling, per the Naming page "Maximum Path Length Limitation"
// section (~32k wide chars). Inputs beyond this fail closed.
#define WCORE_MAX_VOLUME_BYTES 32767

static int is_sep(char c) {
  return c == '\\' || c == '/';
}

static int starts_with(const char *s, size_t len, const char *prefix) {
  size_t n = strlen(prefix);
  if (len < n) return 0;
  for (size_t i = 0; i < n; i++) {
    char a = s[i];
    char b = prefix[i];
    if (a == '/' && b == '\\') continue;
    if (a != b) return 0;
  }
  return 1;
}

const char *wcore_open_root(const char *volume_path, int *out_fd) {
  if (volume_path == NULL || out_fd == NULL) return "EINVAL";
  size_t len = strlen(volume_path);
  if (len == 0 || len > WCORE_MAX_VOLUME_BYTES) return "EINVAL";
  // Device/NT-namespace caller inputs are never accepted as roots.
  if (starts_with(volume_path, len, "\\\\?\\") ||
      starts_with(volume_path, len, "\\\\.\\") ||
      starts_with(volume_path, len, "\\??\\"))
    return "EINVAL";
  // First-cut limitation: UNC has no handle-relative walk yet. Refuse
  // loudly; never fall back to an absolute-path join.
  if (starts_with(volume_path, len, "\\\\") || starts_with(volume_path, len, "//"))
    return "ENOTSUP";
  // Only drive-absolute roots ("C:\..." / "C:/..."). Drive-relative ("C:foo")
  // and bare-absolute ("\foo") inputs are rejected: EINVAL.
  if (len < 3 || !((volume_path[0] >= 'A' && volume_path[0] <= 'Z') ||
          (volume_path[0] >= 'a' && volume_path[0] <= 'z')) ||
      volume_path[1] != ':' || !is_sep(volume_path[2]))
    return "EINVAL";

  WCHAR root_w[4];
  root_w[0] = (WCHAR)volume_path[0];
  root_w[1] = L':';
  root_w[2] = L'\\';
  root_w[3] = L'\0';
  HANDLE current = CreateFileW(root_w, GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL);
  if (current == INVALID_HANDLE_VALUE) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  const char *anchor = wcore_assert_dir_noreparse(current);
  if (anchor != NULL) {
    CloseHandle(current);
    return anchor;
  }

  const char *p = volume_path + 3;
  while (*p != '\0') {
    while (is_sep(*p)) p++;
    if (*p == '\0') break;
    const char *end = p;
    while (*end != '\0' && !is_sep(*end)) end++;
    size_t comp_len = (size_t)(end - p);
    const char *valid = wcore_validate_component(p, comp_len);
    if (valid != NULL) {
      CloseHandle(current);
      return valid;
    }
    // UTF-8 bytes to UTF-16 for the NT call. The validator already bounded
    // the byte length; stack space below is sized accordingly.
    WCHAR wcomp[1024];
    char comp_nul[1025];
    memcpy(comp_nul, p, comp_len);
    comp_nul[comp_len] = '\0';
    DWORD wlen = 0;
    const char *conv =
        wcore_wide_from_utf8(comp_nul, comp_len, wcomp, 1024, &wlen);
    if (conv != NULL) {
      CloseHandle(current);
      return conv;
    }
    HANDLE next = NULL;
    const char *opened = wcore_nt_create_child(current, wcomp, wlen,
        WCORE_OPTS_DIR, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES |
            SYNCHRONIZE,
        &next);
    if (opened != NULL) {
      CloseHandle(current);
      return opened;
    }
    const char *ok = wcore_assert_dir_noreparse(next);
    if (ok != NULL) {
      CloseHandle(next);
      CloseHandle(current);
      return ok;
    }
    CloseHandle(current);
    current = next;
    p = end;
  }

  // Bridge to a CRT fd. uv_open_osfhandle consumes `current`: never
  // CloseHandle after success; the fd dies with Node close (libuv _close).
  int fd = uv_open_osfhandle((uv_os_fd_t)current);
  if (fd < 0) {
    CloseHandle(current);
    return "EMFILE";
  }
  *out_fd = fd;
  return NULL;
}
#endif
