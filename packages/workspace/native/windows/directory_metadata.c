// Handle-relative metadata + directory enumeration for the Windows core.
//
// statAt: opens one validated component with NtCreateFile(RootDirectory=parent,
// no absolute join) using metadata-only access and OPEN_REPARSE_POINT, then
// queries FileIdInfo + FileBasicInfo + FileStandardInfo +
// FileAttributeTagInformation on the SAME handle (never Node Stats doubles).
// Any reparse point reports S_IFLNK; callers deny. Returns lossless vol/id hex
// (same stored-order format as identityOf) plus synthesized POSIX mode, size,
// Unix mtimeMs, and raw FileAttributes for future consumer integration.
//
// names: FileIdExtdDirectoryInfo batches on the borrowed directory handle,
// restarting every call (first batch FileIdExtdDirectoryRestartInfo, then
// FileIdExtdDirectoryInfo until ERROR_NO_MORE_FILES) so repeated names() on
// the same fd restarts instead of continuing. Skips "." / ".."; cap counts
// accepted names only (1..10000 else EINVAL); a further accepted entry is
// E2BIG before it is published to the JS sink. Converts FileName (WCHAR) to
// UTF-8 with WC_ERR_INVALID_CHARS so unpaired surrogates fail closed;
// embedded NUL or OOB entries fail closed. Unicode is otherwise preserved
// byte-for-byte.
//
// Primary sources (fresh, no other-project code):
// - GetFileInformationByHandleEx info classes + FILE_ID_INFO / FILE_BASIC_INFO
//   / FILE_STANDARD_INFO / FILE_ATTRIBUTE_TAG_INFO / FILE_ID_EXTD_DIR_INFO +
//   FileIdExtdDirectoryInfo / FileIdExtdDirectoryRestartInfo restart rule:
//   Microsoft Learn "GetFileInformationByHandleEx function"
//   (https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex)
//   and "FILE_ID_EXTD_DIR_INFO structure"
//   (https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_extd_dir_info).
// - NtCreateFile RootDirectory relative resolution + OPEN_REPARSE_POINT +
//   CreateOptions values: Microsoft Learn "NtCreateFile function (ntifs.h)"
//   (https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile).
// - WideCharToMultiByte strict conversion: Microsoft Learn "stringapiset"
//   (MB_ERR_INVALID_CHARS / WC_ERR_INVALID_CHARS fail closed, no U+FFFD).
// - FILETIME epoch (1601-01-01, 100ns ticks; Unix epoch delta 11644473600s,
//   signed arithmetic so pre-1970 times stay negative):
//   Microsoft Learn "FILETIME structure"
//   (https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ns-minwinbase-filetime).
// - Error codes: Microsoft Learn "System Error Codes"
//   (https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes).
//
// Bounds: one fixed 64KB batch buffer reused for every batch; enumeration
// loops until ERROR_NO_MORE_FILES. Every entry walk is bounds-checked; any
// violation fails closed with EIO.

#ifdef _WIN32
// Win10 baseline so FILE_ID_EXTD_DIR_INFO + FileIdExtdDirectoryInfo /
// FileIdExtdDirectoryRestartInfo declarations are present (matches nt_bridge.c).
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include "windows_core.h"

#define WCORE_DIR_CAP 10000
#define WCORE_DIR_BATCH 65536

static const char *stat_handle(HANDLE child, char vol_hex[17],
    char id_hex[33], unsigned int *mode, unsigned long long *size,
    double *mtime_ms, unsigned int *attrs) {
  if (child == NULL || vol_hex == NULL || id_hex == NULL || mode == NULL ||
      size == NULL || mtime_ms == NULL || attrs == NULL)
    return "EINVAL";
  FILE_ATTRIBUTE_TAG_INFO tag;
  memset(&tag, 0, sizeof(tag));
  if (!GetFileInformationByHandleEx(
          child, FileAttributeTagInfo, &tag, sizeof(tag))) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  FILE_ID_INFO fid;
  memset(&fid, 0, sizeof(fid));
  if (!GetFileInformationByHandleEx(child, FileIdInfo, &fid, sizeof(fid))) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  FILE_BASIC_INFO basic;
  memset(&basic, 0, sizeof(basic));
  if (!GetFileInformationByHandleEx(child, FileBasicInfo, &basic, sizeof(basic))) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  FILE_STANDARD_INFO stdinfo;
  memset(&stdinfo, 0, sizeof(stdinfo));
  if (!GetFileInformationByHandleEx(
          child, FileStandardInfo, &stdinfo, sizeof(stdinfo))) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  int is_reparse = (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  int is_dir = (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  int readonly = (tag.FileAttributes & FILE_ATTRIBUTE_READONLY) != 0;
  if (is_reparse)
    *mode = 0120000 | 0777;
  else if (is_dir)
    *mode = 0040000 | (readonly ? 0555 : 0777);
  else
    *mode = 0100000 | (readonly ? 0444 : 0666);
  if (stdinfo.EndOfFile.QuadPart < 0) {
    return "EIO";
  }
  *size = (unsigned long long)stdinfo.EndOfFile.QuadPart;
  // Signed tick arithmetic: pre-1970 LastWriteTime stays negative.
  // Integer ms plus sub-ms remainder keeps ms-set times exact in doubles.
  {
    LONGLONG delta =
        basic.LastWriteTime.QuadPart - 116444736000000000LL;
    LONGLONG ms = delta / 10000;
    LONG rem = (LONG)(delta % 10000);
    *mtime_ms = (double)ms + ((double)rem) / 10000.0;
  }
  *attrs = (unsigned int)tag.FileAttributes;
  wcore_format_vol((ULONGLONG)fid.VolumeSerialNumber, vol_hex);
  wcore_format_id(&fid.FileId, id_hex);
  return NULL;
}

const char *wcore_stat_at(int parent_fd, const char *name, char vol_hex[17],
    char id_hex[33], unsigned int *mode, unsigned long long *size,
    double *mtime_ms, unsigned int *attrs) {
  if (name == NULL || vol_hex == NULL || id_hex == NULL || mode == NULL ||
      size == NULL || mtime_ms == NULL || attrs == NULL)
    return "EINVAL";
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
  // Metadata-only open: no data access, never follows reparse, works for
  // files and directories (no DIRECTORY/NON_DIRECTORY constraint).
  ULONG opts =
      WCORE_FILE_SYNCHRONOUS_IO_NONALERT | WCORE_FILE_OPEN_REPARSE_POINT;
  HANDLE child = NULL;
  const char *opened = wcore_nt_create_child(
      parent, wname, wlen, opts, FILE_READ_ATTRIBUTES | SYNCHRONIZE, &child);
  if (opened != NULL) return opened;
  const char *code =
      stat_handle(child, vol_hex, id_hex, mode, size, mtime_ms, attrs);
  CloseHandle(child);
  return code;
}

const char *wcore_stat_fd(int fd, char vol_hex[17],
    char id_hex[33], unsigned int *mode, unsigned long long *size,
    double *mtime_ms, unsigned int *attrs) {
  if (vol_hex == NULL || id_hex == NULL || mode == NULL ||
      size == NULL || mtime_ms == NULL || attrs == NULL)
    return "EINVAL";
  HANDLE handle = NULL;
  const char *borrowed = wcore_borrow_handle(fd, &handle);
  if (borrowed != NULL) return borrowed;
  // Borrowed only: never close here; ownership stays with the JS side.
  return stat_handle(handle, vol_hex, id_hex, mode, size, mtime_ms, attrs);
}

const char *wcore_names_collect(int dir_fd, int cap, wcore_name_sink_fn sink,
    void *ctx, int *out_count) {
  if (cap < 1 || cap > WCORE_DIR_CAP) return "EINVAL";
  if (sink == NULL || out_count == NULL) return "EINVAL";
  HANDLE handle = NULL;
  const char *borrowed = wcore_borrow_handle(dir_fd, &handle);
  if (borrowed != NULL) return borrowed;
  const char *directory_type = wcore_assert_dir_noreparse(handle);
  if (directory_type != NULL) return directory_type;
  BYTE *base = (BYTE *)malloc(WCORE_DIR_BATCH);
  if (base == NULL) return "ENOMEM";
  BYTE *end = base + WCORE_DIR_BATCH;
  size_t header = offsetof(FILE_ID_EXTD_DIR_INFO, FileName);
  int accepted = 0;
  int restart = 1;
  for (;;) {
    FILE_INFO_BY_HANDLE_CLASS cls = restart ? FileIdExtdDirectoryRestartInfo
                                            : FileIdExtdDirectoryInfo;
    restart = 0;
    memset(base, 0, WCORE_DIR_BATCH);
    if (!GetFileInformationByHandleEx(handle, cls, base, WCORE_DIR_BATCH)) {
      DWORD dos = GetLastError();
      if (dos == ERROR_NO_MORE_FILES) break;
      free(base);
      const char *code = wcore_dos_to_code(dos);
      return code != NULL ? code : "EIO";
    }
    BYTE *p = base;
    for (;;) {
      size_t remaining = (size_t)(end - p);
      if (remaining < header) {
        free(base);
        return "EIO";
      }
      FILE_ID_EXTD_DIR_INFO *entry = (FILE_ID_EXTD_DIR_INFO *)(void *)p;
      DWORD name_bytes = entry->FileNameLength;
      if (name_bytes == 0 || name_bytes % 2 != 0) {
        free(base);
        return "EIO";
      }
      if ((size_t)name_bytes > remaining - header) {
        free(base);
        return "EIO";
      }
      DWORD next = entry->NextEntryOffset;
      if (next != 0) {
        if (next < header + name_bytes || (size_t)next >= remaining) {
          free(base);
          return "EIO";
        }
      }
      WCHAR *fname = (WCHAR *)(void *)(p + header);
      DWORD wlen = name_bytes / 2;
      int is_dot = (wlen == 1 && fname[0] == L'.');
      int is_dotdot = (wlen == 2 && fname[0] == L'.' && fname[1] == L'.');
      if (!is_dot && !is_dotdot && wlen > 0) {
        // The cap counts accepted names only; the overflow entry is never
        // published to the sink.
        if (accepted >= cap) {
          free(base);
          return "E2BIG";
        }
        char utf8[1025];
        int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, fname,
            (int)wlen, utf8, (int)sizeof(utf8) - 1, NULL, NULL);
        if (n <= 0) {
          DWORD dos = GetLastError();
          free(base);
          const char *code = wcore_dos_to_code(dos);
          return code != NULL ? code : "EIO";
        }
        utf8[n] = '\0';
        if ((size_t)n != strlen(utf8)) {
          free(base);
          return "EIO";
        }
        if (sink(utf8, (size_t)n, ctx) != 0) {
          free(base);
          return "EIO";
        }
        accepted++;
      }
      if (next == 0) break;
      p += next;
    }
  }
  *out_count = accepted;
  free(base);
  return NULL;
}
#endif
