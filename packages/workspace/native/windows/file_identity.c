// Lossless FileIdInfo identity formatting for the Windows handle core.
//
// Primary sources:
// - GetFileInformationByHandleEx + FILE_ID_INFO (VolumeSerialNumber u64,
//   FileId 128-bit): Windows SDK fileapi.h
//   (https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex).
// - Why strings, never Node Stats dev:ino doubles: libuv fills uv_stat_t
//   lossily on Windows (st_dev is only VolumeSerialNumber.LowPart, st_ino is
//   the 64-bit index rather than the 128-bit FileId; ReFS does not guarantee
//   the 64-bit index is unique). See docs/research/windows-workspace-backend.md
//   section 5. Identity here is (vol hex, id hex) compared by string equality;
//   no numeric truncation, no endianness reinterpretation — the 16 identifier
//   bytes are formatted in stored order.
//
// The HANDLE is borrowed via the single shared wcore_borrow_handle wrapper
// (Node libuv fd validation, see windows_core.h; still CRT-owned;
// never closed here). The fd must stay open for the call.

#ifdef _WIN32
#include <windows.h>
#include "windows_core.h"
#include <string.h>

static char nibble(unsigned int v) {
  return (char)(v < 10 ? ('0' + v) : ('a' + (v - 10)));
}

// Single owner of the lossless hex format (also used by wcore_stat_at).
void wcore_format_vol(ULONGLONG vol, char out[17]) {
  for (int i = 0; i < 16; i++) {
    unsigned long long shift = (unsigned long long)(15 - i) * 4ULL;
    out[i] = nibble((unsigned int)((vol >> shift) & 0xFULL));
  }
  out[16] = '\0';
}

void wcore_format_id(const FILE_ID_128 *id, char out[33]) {
  for (int i = 0; i < 16; i++) {
    unsigned char byte = id->Identifier[i];
    out[i * 2] = nibble((unsigned int)(byte >> 4));
    out[i * 2 + 1] = nibble((unsigned int)(byte & 0x0F));
  }
  out[32] = '\0';
}

#endif
