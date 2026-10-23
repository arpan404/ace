// Same-parent renames using an opened source and a pinned destination directory.
// No absolute path resolution or target traversal occurs.
// https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info
#ifdef _WIN32
#include "windows_core.h"
#include <stdlib.h>
#include <string.h>

static const char *rename_child(int parent_fd, const char *from,
    const char *to, BOOLEAN replace) {
  if (from == NULL || to == NULL) return "EINVAL";
  HANDLE parent = NULL;
  const char *code = wcore_borrow_handle(parent_fd, &parent);
  if (code != NULL) return code;
  code = wcore_assert_dir_noreparse(parent);
  if (code != NULL) return code;
  code = wcore_validate_component(from, strlen(from));
  if (code != NULL) return code;
  code = wcore_validate_component(to, strlen(to));
  if (code != NULL) return code;
  WCHAR source[1024], destination[1024];
  DWORD source_len = 0, destination_len = 0;
  code = wcore_wide_from_utf8(from, strlen(from), source, 1024, &source_len);
  if (code != NULL) return code;
  code = wcore_wide_from_utf8(to, strlen(to), destination, 1024, &destination_len);
  if (code != NULL) return code;
  HANDLE child = NULL;
  // Reparse points are opened and renamed themselves, never followed.
  code = wcore_nt_create_child(parent, source, source_len,
      WCORE_FILE_SYNCHRONOUS_IO_NONALERT | WCORE_FILE_OPEN_REPARSE_POINT,
      DELETE | SYNCHRONIZE, &child);
  if (code != NULL) return code;
  DWORD name_bytes = destination_len * sizeof(WCHAR);
  DWORD size = (DWORD)sizeof(FILE_RENAME_INFO) + name_bytes;
  FILE_RENAME_INFO *info = (FILE_RENAME_INFO *)calloc(1, size);
  if (info == NULL) {
    CloseHandle(child);
    return "ENOMEM";
  }
  info->ReplaceIfExists = replace;
  info->RootDirectory = parent;
  info->FileNameLength = name_bytes;
  memcpy(info->FileName, destination, name_bytes);
  if (!SetFileInformationByHandle(child, FileRenameInfo, info, size))
    code = wcore_dos_to_code(GetLastError());
  free(info);
  if (!CloseHandle(child) && code == NULL)
    code = wcore_dos_to_code(GetLastError());
  return code;
}

const char *wcore_rename_at(int parent_fd, const char *from, const char *to) {
  return rename_child(parent_fd, from, to, TRUE);
}

const char *wcore_rename_exclusive_at(int parent_fd, const char *from, const char *to) {
  return rename_child(parent_fd, from, to, FALSE);
}
#endif
