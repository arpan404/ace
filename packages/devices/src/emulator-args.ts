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
 * (SwiftShader); on macOS the host GPU (Metal) is always there, so it is asked for by name. On
 * Linux ace asks for `auto` by name: an AVD saved with hardware graphics (`host`) would otherwise
 * keep it, and without a GPU (a server, a VM, CI) that emulator never finishes booting. Measured
 * on GitHub's x64 runners (KVM, no GPU), every software mode booted and streamed alike; `host`
 * did not boot (ADR 0064, 2026-10-21).
 * `gpu` (from `ACE_ANDROID_EMULATOR_GPU`) overrides that choice: a mode the emulator's `-gpu`
 * flag takes, or `none` to pass no flag at all.
 */
export function emulatorBootArgs(input: {
  avd: string;
  port: number;
  window: boolean;
  platform: string;
  gpu?: string | undefined;
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
  const gpu = emulatorGpu(input.gpu) ?? (input.window ? undefined : defaultGpu(input.platform));
  const mode = gpu && gpu !== "none" ? ["-gpu", gpu] : [];
  if (input.window) return [...base, ...mode];
  return [...base, "-no-window", "-no-boot-anim", ...mode];
}

/** A `-gpu` mode as the person set it, when it is one the emulator could take. */
function emulatorGpu(value: string | undefined): string | undefined {
  const mode = value?.trim().toLowerCase();
  return mode && /^[a-z_]{1,32}$/.test(mode) ? mode : undefined;
}

function defaultGpu(platform: string): string | undefined {
  if (platform === "darwin") return "host";
  return platform === "linux" ? "auto" : undefined;
}
