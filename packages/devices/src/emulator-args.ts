/**
 * The command line ace boots an Android emulator with. ace shows and drives the device
 * itself, so by default the emulator runs without its own window and boot animation; quick
 * boot snapshots are left as the AVD has them. The person can ask for the window, for the
 * emulator's extended controls.
 *
 * On a Mac the emulator also serves its screen over gRPC (localhost, token auth) so ace encodes
 * the picture with the Mac's hardware instead of the emulator's software encoder.
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
  const base = [
    "-avd",
    input.avd,
    "-port",
    String(input.port),
    // On a Mac the picture is encoded on the host (`host-frames.ts`): the emulator streams its
    // screen over gRPC on localhost, behind its console token, by the usual console + 3000 port.
    ...(input.platform === "darwin" ? ["-grpc", String(input.port + 3000), "-grpc-use-token"] : []),
  ];
  if (input.window) return base;
  return [
    ...base,
    "-no-window",
    "-no-boot-anim",
    ...(input.platform === "darwin" ? ["-gpu", "host"] : []),
  ];
}
