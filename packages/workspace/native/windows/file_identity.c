// identityOf for the Windows handle core: lossless FileIdInfo strings.
//
// Primary sources:
// - GetFileInformationByHandleEx + FILE_ID_INFO (VolumeSerialNumber u64,
//   FileId 128-bit): Windows SDK fileapi.h
//   (https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandleex).
// - Why strings, never Node Stats dev:ino doubles: libuv fills uv_stat_t
//   lossily on Windows (st_dev is only VolumeSerialNumber.LowPart, st_ino is
//   the 64-bit index rather than the 128-bit FileId; ReFS does not guarantee
//   the 64-bit index is unique). See docs/research/windows-workspace-backend.md
//   section 5. Identity here is (vol hex, id hex) compared by string equality;
//   no numeric truncation, no endianness reinterpretation — the 16 identifier
//   bytes are formatted in stored order.
//
// The HANDLE is borrowed via the single shared wcore_borrow_handle wrapper
// (thread-local invalid-parameter guard, see windows_core.h; still CRT-owned;
// never closed here). The fd must stay open for the call.

#ifdef _WIN32
#include <windows.h>
#include "windows_core.h"
#include <string.h>

static char nibble(unsigned int v) {
  return (char)(v < 10 ? ('0' + v) : ('a' + (v - 10)));
}

const char *wcore_identity_of(int fd, char vol_hex[17], char id_hex[33]) {
  if (vol_hex == NULL || id_hex == NULL) return "EINVAL";
  HANDLE handle = NULL;
  const char *borrowed = wcore_borrow_handle(fd, &handle);
  if (borrowed != NULL) return borrowed;
  FILE_ID_INFO info;
  memset(&info, 0, sizeof(info));
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info))) {
    const char *code = wcore_dos_to_code(GetLastError());
    return code != NULL ? code : "EIO";
  }
  // VolumeSerialNumber as 16 zero-padded lowercase hex chars (MSB first).
  for (int i = 0; i < 16; i++) {
    unsigned long long shift = (unsigned long long)(15 - i) * 4ULL;
    vol_hex[i] = nibble((unsigned int)((info.VolumeSerialNumber >> shift) & 0xFULL));
  }
  vol_hex[16] = '\0';
  // 128-bit FileId as 32 lowercase hex chars in stored byte order.
  for (int i = 0; i < 16; i++) {
    unsigned char byte = info.FileId.Identifier[i];
    id_hex[i * 2] = nibble((unsigned int)(byte >> 4));
    id_hex[i * 2 + 1] = nibble((unsigned int)(byte & 0x0F));
  }
  id_hex[32] = '\0';
  return NULL;
}
#endif
