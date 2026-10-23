// Delete a single child through its pinned parent, never an absolute path.
// FILE_OPEN_REPARSE_POINT opens the link itself. FileDispositionInfo requires
// DELETE access and removes the opened object when its final handle closes.
// https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle
#ifdef _WIN32
#include "windows_core.h"
#include <string.h>

static const char *delete_child(int parent_fd, const char *name,
    DWORD expected_directory) {
  if (name == NULL) return "EINVAL";
  HANDLE parent = NULL;
  const char *code = wcore_borrow_handle(parent_fd, &parent);
  if (code != NULL) return code;
  code = wcore_assert_dir_noreparse(parent);
  if (code != NULL) return code;
  size_t len = strlen(name);
  code = wcore_validate_component(name, len);
  if (code != NULL) return code;
  WCHAR wide[1024];
  DWORD used = 0;
  code = wcore_wide_from_utf8(name, len, wide, 1024, &used);
  if (code != NULL) return code;
  HANDLE child = NULL;
  // Omit directory/non-directory constraints so type errors are explicit and
  // reparse directories can be removed without touching their target.
  code = wcore_nt_create_child(parent, wide, used,
      WCORE_FILE_SYNCHRONOUS_IO_NONALERT | WCORE_FILE_OPEN_REPARSE_POINT,
      DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &child);
  if (code != NULL) return code;
  FILE_ATTRIBUTE_TAG_INFO attrs;
  if (!GetFileInformationByHandleEx(child, FileAttributeTagInfo,
          &attrs, sizeof(attrs))) {
    code = wcore_dos_to_code(GetLastError());
  } else if ((attrs.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != expected_directory) {
    code = expected_directory ? "ENOTDIR" : "EISDIR";
  } else {
    FILE_DISPOSITION_INFO disposition;
    disposition.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(child, FileDispositionInfo,
            &disposition, sizeof(disposition)))
      code = wcore_dos_to_code(GetLastError());
  }
  if (!CloseHandle(child) && code == NULL)
    code = wcore_dos_to_code(GetLastError());
  return code;
}

const char *wcore_unlink_at(int parent_fd, const char *name) {
  return delete_child(parent_fd, name, 0);
}

const char *wcore_remove_directory_at(int parent_fd, const char *name) {
  return delete_child(parent_fd, name, FILE_ATTRIBUTE_DIRECTORY);
}
#endif
