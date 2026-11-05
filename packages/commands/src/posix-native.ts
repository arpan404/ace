import { openLibrary, type NativeFunction } from "@ace/provider-kit/bun-ffi";

// OS interface declarations only. No provider or third-party implementation code.
function bindings() {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
    throw new Error("Secure command discovery requires 64-bit macOS or Linux");
  const darwin = process.platform === "darwin";
  const suffix = darwin && process.arch === "x64" ? "$INODE64" : "";
  // renameatx_np (macOS) and renameat2 (Linux) take the same arguments; only flag values differ.
  const renameFlags = darwin ? "renameatx_np" : "renameat2";
  const library = openLibrary(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    readlinkat: { args: ["i32", "ptr", "ptr", "u64"], returns: "i64_fast" },
    mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
    renameat: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
    unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    linkat: { args: ["i32", "ptr", "i32", "ptr", "i32"], returns: "i32" },
    symlinkat: { args: ["ptr", "i32", "ptr"], returns: "i32" },
    [renameFlags]: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
    [`fdopendir${suffix}`]: { args: ["i32"], returns: "ptr" },
    [`readdir${suffix}`]: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
  });
  const bound = (name: string): NativeFunction => {
    const fn = library.symbols[name];
    if (!fn) throw new Error(`Missing native function ${name}`);
    return fn;
  };
  return {
    openat: bound("openat"),
    readlinkat: bound("readlinkat"),
    mkdirat: bound("mkdirat"),
    renameat: bound("renameat"),
    unlinkat: bound("unlinkat"),
    linkat: bound("linkat"),
    symlinkat: bound("symlinkat"),
    closedir: bound("closedir"),
    close: bound("close"),
    renameFlags: bound(renameFlags),
    fdopendir: bound(`fdopendir${suffix}`),
    readdir: bound(`readdir${suffix}`),
  };
}
export type PosixBindings = ReturnType<typeof bindings>;
let native: PosixBindings | undefined;
/** The C functions command workers call, bound on first use. */
export function posixBindings(): PosixBindings {
  return (native ??= bindings());
}
