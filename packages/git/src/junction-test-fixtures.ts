import { z } from "zod";
import { openLibrary, wideString } from "@ace/provider-kit/bun-ffi";

/**
 * Windows test fixture: turns the existing folder `directory` itself into a junction to `target`
 * (FSCTL_SET_REPARSE_POINT with a mount-point buffer), as an agent racing ace could. Returns
 * whether Windows accepted it; it refuses a folder that has any entry.
 */
export function junctionInPlace(directory: string, target: string): boolean {
  const kernel = openLibrary("kernel32.dll", {
    CreateFileW: {
      args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "i64_fast"],
      returns: "i64_fast",
    },
    DeviceIoControl: {
      args: ["i64_fast", "u32", "ptr", "u32", "ptr", "u32", "ptr", "ptr"],
      returns: "i32",
    },
    CloseHandle: { args: ["i64_fast"], returns: "i32" },
  });
  const { CreateFileW: open, DeviceIoControl: control, CloseHandle: close } = kernel.symbols;
  try {
    const substitute = Buffer.from(`\\??\\${target}`, "utf16le");
    const print = Buffer.from(target, "utf16le");
    const names = Buffer.concat([substitute, Buffer.alloc(2), print, Buffer.alloc(2)]);
    const data = Buffer.alloc(16 + names.length);
    data.writeUInt32LE(0xa0000003, 0);
    data.writeUInt16LE(8 + names.length, 4);
    data.writeUInt16LE(0, 8);
    data.writeUInt16LE(substitute.length, 10);
    data.writeUInt16LE(substitute.length + 2, 12);
    data.writeUInt16LE(print.length, 14);
    names.copy(data, 16);
    // GENERIC_WRITE; share everything; OPEN_EXISTING; backup semantics, the folder itself.
    const handle = z
      .number()
      .parse(open(wideString(directory), 0x40000000, 0x7, null, 3, 0x02200000, 0));
    if (handle === -1 || handle === 0) return false;
    try {
      return (
        z
          .number()
          .parse(control(handle, 0x900a4, data, data.length, null, 0, new Uint32Array(1), null)) !==
        0
      );
    } finally {
      close(handle);
    }
  } finally {
    kernel.close();
  }
}
