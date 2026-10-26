// Single-component lexical validator for the Windows handle core.
//
// Primary source: Microsoft Learn "Naming Files, Paths, and Namespaces"
// (https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file):
// reserved characters < > : " / \ | ? *, controls 1..31, reserved stems
// CON PRN AUX NUL COM1-9 LPT1-9 (+ superscript 1-3, U+00B9/B2/B3, treated as
// digits per the same page), no trailing space/dot. Mirrors the TS-side
// win32 lexical policy (src/path-policy.ts) so both layers agree; the native
// layer is authoritative for the fd boundary.
//
// Portable C11: no Win32 calls, so this file syntax-checks on any host.
// Reparse points are NOT lexical — they are refused at open time by checking
// FILE_ATTRIBUTE_REPARSE_POINT on the freshly opened handle (see child_open.c
// / volume_root.c). ADS is lexical (any ':' is rejected).
//
// The byte cap below is a sanity bound before UTF-16 conversion; the file
// system enforces its own per-component limit and any failure there maps to
// EINVAL at the NT boundary.

#include "windows_core.h"

// Conservative first-cut byte cap. It only keeps inputs bounded before
// UTF-16 conversion; every valid component is far shorter, and overlong
// names fail at the NT boundary with EINVAL.
#define WCORE_MAX_COMPONENT_BYTES 1024

static char ascii_upper(char c) {
  return (c >= 'a' && c <= 'z') ? (char)(c - ('a' - 'A')) : c;
}

// Case-insensitive ASCII compare of exactly n bytes.
static int ascii_case_equal(const char *a, const char *b, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (ascii_upper(a[i]) != ascii_upper(b[i])) return 0;
  }
  return 1;
}

// Reserved stems, case-insensitive, per the Naming page. The stem is the name
// up to the first '.' ("NUL.txt" is NUL). ASCII trailing spaces are stripped
// from the stem before comparison ("CON .txt" is CON; the shell strips such
// spaces, so the check must too). Only 0x20 is stripped: controls are already
// rejected, and Unicode whitespace stays significant and remains valid.
// Plain 3-letter stems plus COM/LPT followed by an ASCII digit or a
// superscript digit (U+00B9 0xC2B9, U+00B2 0xC2B2, U+00B3 0xC2B3 — UTF-8
// two-byte sequences).
static int is_reserved_stem(const char *stem, size_t len) {
  if (len == 3) {
    return ascii_case_equal(stem, "CON", 3) || ascii_case_equal(stem, "PRN", 3) ||
        ascii_case_equal(stem, "AUX", 3) || ascii_case_equal(stem, "NUL", 3);
  }
  if (len == 4) {
    if ((ascii_case_equal(stem, "COM", 3) || ascii_case_equal(stem, "LPT", 3)) &&
        stem[3] >= '1' && stem[3] <= '9')
      return 1;
    return 0;
  }
  // 3 ASCII letters + 2-byte superscript digit = 5 bytes.
  if (len == 5) {
    if (!(ascii_case_equal(stem, "COM", 3) || ascii_case_equal(stem, "LPT", 3)))
      return 0;
    if ((unsigned char)stem[3] != 0xC2) return 0;
    unsigned char tail = (unsigned char)stem[4];
    return tail == 0xB9 || tail == 0xB2 || tail == 0xB3;
  }
  return 0;
}

const char *wcore_validate_component(const char *name, size_t len) {
  if (name == NULL) return "EINVAL";
  if (len == 0 || len > WCORE_MAX_COMPONENT_BYTES) return "EINVAL";
  // Embedded NUL would truncate the C string the caller passes on.
  for (size_t i = 0; i < len; i++) {
    if (name[i] == '\0') return "EINVAL";
  }
  if (len == 1 && name[0] == '.') return "EINVAL";
  if (len == 2 && name[0] == '.' && name[1] == '.') return "EINVAL";
  // Trailing space/dot: the shell cannot address these; refusing avoids a
  // class where Win32 silently strips what NTFS keeps.
  if (name[len - 1] == ' ' || name[len - 1] == '.') return "EINVAL";
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)name[i];
    if (c < 32) return "EINVAL";
    switch (c) {
      case '/':
      case '\\':
      case ':':
      case '"':
      case '<':
      case '>':
      case '|':
      case '?':
      case '*':
        return "EINVAL";
      default:
        break;
    }
  }
  // Drive-relative ("C:foo") and device-namespace ("//?/") inputs cannot be a
  // single component anyway, but ':'/'/' rejection above already covers them.
  // Reserved stems: compare the part before the first '.', with only ASCII
  // trailing spaces stripped ("CON .txt" is CON). Unicode whitespace is
  // significant and stays valid.
  size_t stem_len = len;
  for (size_t i = 0; i < len; i++) {
    if (name[i] == '.') {
      stem_len = i;
      break;
    }
  }
  while (stem_len > 0 && name[stem_len - 1] == ' ') stem_len--;
  // A leading-dot name (".temp") has an empty stem and stays valid.
  if (stem_len > 0 && is_reserved_stem(name, stem_len)) return "EINVAL";
  return NULL;
}
