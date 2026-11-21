import type { MarketEntryType, MarketScanFinding } from "@ace/protocol/marketplace";
import type { ArchiveFile } from "../archive.ts";
import { isLicencePath, licenceProblem } from "./licence.ts";
import { wasmKind } from "../code.ts";

/*
 * The `files` check (ADR 0174 §8): nothing executable or packaged travels in an entry. Native
 * programs are told by their first bytes (Mach-O, fat Mach-O, ELF, PE, Java class), WASM outside a
 * plugin by its header (but a bot package's components under `code/`, ADR 0203: the bot checks
 * read their manifest entries and the signer the binary), a compiled AppleScript by its `FasdUAS` marker, and an archive inside the
 * archive by its own magic (zip, gzip, tar, 7z, rar, xz, bzip2, xar, dmg). An executable bit on a
 * type that has none is a finding, and a Suit may hold only its own file kinds (plus plain-text licences, see licence.ts). Pure.
 */

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[at + i] !== signature[i]) return false;
  return true;
}

/** A native program by its first bytes; the label names it, or undefined. */
function nativeProgram(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return "a Linux ELF program";
  if (startsWith(bytes, [0x4d, 0x5a])) return "a Windows PE program";
  if (startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe])) return "a Java class or fat Mach-O program";
  if (startsWith(bytes, [0xbe, 0xba, 0xfe, 0xca])) return "a fat Mach-O program";
  // Mach-O, 32- and 64-bit, both byte orders.
  for (const magic of [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xcf, 0xfa, 0xed, 0xfe],
  ])
    if (startsWith(bytes, magic)) return "a Mach-O program";
  return undefined;
}

/** An archive or disk image by its first bytes; the label names it, or undefined. */
function archiveKind(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]))
    return "a zip archive";
  if (startsWith(bytes, [0x1f, 0x8b])) return "a gzip archive";
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "a 7z archive";
  if (startsWith(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return "a RAR archive";
  if (startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "an xz archive";
  if (startsWith(bytes, [0x42, 0x5a, 0x68])) return "a bzip2 archive";
  if (startsWith(bytes, [0x78, 0x61, 0x72, 0x21])) return "a xar archive";
  if (startsWith(bytes, [0x6b, 0x6f, 0x6c, 0x79])) return "a dmg disk image";
  // POSIX tar: "ustar" at offset 257.
  if (bytes.length >= 262 && startsWith(bytes, [0x75, 0x73, 0x74, 0x61, 0x72], 257))
    return "a tar archive";
  return undefined;
}

/** WASM by its `\0asm` header. Allowed inside a plugin; a finding anywhere else. */
function isWasm(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x00, 0x61, 0x73, 0x6d]);
}

/** A bot package's WebAssembly component: a component (never a core module) at `code/<name>.wasm`. */
const packageComponent = (type: MarketEntryType, path: string, bytes: Uint8Array): boolean =>
  type === "spade-bot" &&
  /^code\/[a-z][a-z0-9]{0,23}\.wasm$/.test(path) &&
  wasmKind(bytes) === "component";

/** A compiled AppleScript by its `FasdUAS` marker near the start. */
function isCompiledAppleScript(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0x46, 0x61, 0x73, 0x64, 0x55, 0x41, 0x53])) return true;
  // The marker can follow a short header in `.scpt` resources.
  const window = bytes.subarray(0, 64);
  const marker = [0x46, 0x61, 0x73, 0x64, 0x55, 0x41, 0x53];
  for (let at = 0; at + marker.length <= window.length; at++)
    if (startsWith(window, marker, at)) return true;
  return false;
}

/**
 * Whether a file of `type` may carry an executable bit: a skill's scripts and a plugin's files
 * may (ADR 0168 §8 flags them on the review; the scripts check reads what they do), so may a
 * recipe's bundled skills; a Suit's files and a recipe's own never do.
 */
const mayBeExecutable = (type: MarketEntryType, path: string): boolean =>
  type === "spade-skill" ||
  type === "spade-plugin" ||
  type === "ace-plugin" ||
  (type === "spade-bot" && path.startsWith("skills/"));

/** A Suit holds only these kinds; anything else is a finding. */
const SUIT_ALLOWED =
  /(?:^suit\.json$|^suit\.css$|^market\.json$|^[A-Za-z0-9-]+\.js$|^assets\/.*\.(?:png|jpe?g|webp|gif|svg|avif|woff2?|ttf|otf|mp4|webm|mov|m4v)$)/i;
/** Ornament files a Suit may also hold (markup under assets or at the root). */
const SUIT_ORNAMENT = /\.(?:html?|svg)$/i;

function findingOf(
  path: string,
  message: string,
  level: MarketScanFinding["level"],
  rule: string,
): MarketScanFinding {
  return { check: "files", rule, level, path, message };
}

/** The `files` check over an entry's files. */
export function filesCheck(
  type: MarketEntryType,
  files: readonly ArchiveFile[],
): MarketScanFinding[] {
  const findings: MarketScanFinding[] = [];
  for (const file of files) {
    const bytes = file.content;
    const native = nativeProgram(bytes);
    if (native) {
      findings.push(findingOf(file.path, `${file.path} is ${native}`, "block", "native-binary"));
    }
    const archive = archiveKind(bytes);
    if (archive) {
      findings.push(
        findingOf(
          file.path,
          `${file.path} is ${archive} inside the entry`,
          "block",
          "nested-archive",
        ),
      );
    }
    if (isWasm(bytes) && type !== "spade-plugin" && !packageComponent(type, file.path, bytes)) {
      findings.push(
        findingOf(
          file.path,
          `${file.path} is a WebAssembly module`,
          "block",
          "wasm-outside-plugin",
        ),
      );
    }
    if (isCompiledAppleScript(bytes)) {
      findings.push(
        findingOf(
          file.path,
          `${file.path} is a compiled AppleScript`,
          "block",
          "compiled-applescript",
        ),
      );
    }
    if (file.executable && !mayBeExecutable(type, file.path) && !native) {
      findings.push(
        findingOf(
          file.path,
          `${file.path} carries an executable bit, which this type's files don't take`,
          "warn",
          "executable-bit",
        ),
      );
    }
    if (type === "suit" && file.path !== "market.json") {
      if (file.executable === false && isLicencePath(file.path)) {
        const problem = licenceProblem(file.path, bytes);
        if (problem) findings.push(findingOf(file.path, problem.message, "block", problem.rule));
      } else if (!SUIT_ALLOWED.test(file.path) && !SUIT_ORNAMENT.test(file.path)) {
        findings.push(
          findingOf(
            file.path,
            `${file.path} isn't a file a Suit may hold (suit.json, suit.css, scene JS, ornaments, market.json, licence texts, or images, fonts and videos under assets/)`,
            "block",
            "suit-stray-file",
          ),
        );
      }
    }
  }
  return findings;
}
