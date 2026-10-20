/**
 * The command line ace boots an Android emulator with. ace shows and drives the device
 * itself, so by default the emulator runs without its own window and boot animation; quick
 * boot snapshots are left as the AVD has them. The person can ask for the window, for the
 * emulator's extended controls.
 *
 * Without a window, the emulator's automatic GPU choice falls back to software rendering
 * (SwiftShader); on macOS the host GPU (Metal) is always there, so it is asked for by name.
 */
export function emulatorBootArgs(input: {
  avd: string;
  port: number;
  window: boolean;
  platform: string;
}): string[] {
  const base = ["-avd", input.avd, "-port", String(input.port)];
  if (input.window) return base;
  return [
    ...base,
    "-no-window",
    "-no-boot-anim",
    ...(input.platform === "darwin" ? ["-gpu", "host"] : []),
  ];
}
