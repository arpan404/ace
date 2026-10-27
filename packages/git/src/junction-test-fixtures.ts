import { createRequire } from "node:module";
import type koffiModule from "koffi";
import { z } from "zod";

/**
 * Windows test fixture: turns the existing folder `directory` itself into a junction to `target`
 * (FSCTL_SET_REPARSE_POINT with a mount-point buffer), as an agent racing ace could. Returns
 * whether Windows accepted it; it refuses a folder that has any entry.
 */
export function junctionInPlace(directory: string, target: string): boolean {
  const koffi: typeof koffiModule = createRequire(import.meta.url)("koffi");
  const kernel = koffi.load("kernel32.dll");
  try {
    const open = kernel.func(
      "intptr_t __stdcall CreateFileW(str16 path, uint32 access, uint32 share, void* security, uint32 disposition, uint32 flags, intptr_t template)",
    );
    const control = kernel.func(
      "int __stdcall DeviceIoControl(intptr_t device, uint32 code, void* input, uint32 inputSize, void* output, uint32 outputSize, _Out_ uint32* returned, void* overlapped)",
    );
    const close = kernel.func("int __stdcall CloseHandle(intptr_t handle)");
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
    const handle = z.number().parse(open(directory, 0x40000000, 0x7, null, 3, 0x02200000, 0));
    if (handle === -1 || handle === 0) return false;
    try {
      return (
        z.number().parse(control(handle, 0x900a4, data, data.length, null, 0, [0], null)) !== 0
      );
    } finally {
      close(handle);
    }
  } finally {
    kernel.unload();
  }
}
