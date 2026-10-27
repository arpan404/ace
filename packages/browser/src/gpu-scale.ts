import { z } from "zod";

/*
 * Windows machines without a usable GPU (virtual machines, remote sessions, blocklisted
 * drivers) composite and rasterize ace's Chrome on the CPU. At device scale 2 a 1280 × 800 tab
 * is 2560 × 1600 pixels a frame, and with tab capture running it draws 30–40 fps on such a
 * machine; at scale 1 it draws 60 (measured on GitHub's x64 and ARM64 Windows runners). Live
 * views keep 60 fps and cost resolution instead (ADR 0088, amended). Machines whose Chrome
 * composites on the GPU keep scale 2. The report comes from the managed browser itself, started
 * with its own flags and sandbox (`ChromeBackend`), once per backend: a machine whose GPU comes
 * or goes (a remote session, a driver update) is seen again when the daemon restarts.
 *
 * The other scales, measured on the Windows 11 ARM64 VM with `bench/scale-tradeoff.ts`
 * (delivered fps for a scrolling page; luma PSNR of a Retina viewer's still picture):
 *
 *   scale  fps    odd pane 659 × 825   even pane 660 × 826
 *   1      60.1   22.6 dB              31.4 dB
 *   1.25   58.1   13.9 dB              16.4 dB
 *   1.5    46.5   16.6 dB              15.8 dB
 *   2      32.5   33.8 dB              33.8 dB
 *
 * Fractional scales resample every frame and are both slower and softer; only scale 1 keeps
 * 55/45 fps. An odd pane is softer because Chrome's tab capture delivers even sizes and stretches
 * the page by a pixel; encoding the exact odd size (VP9 takes it) measured no sharper.
 */

const GpuInfo = z.object({
  gpu: z.object({
    devices: z
      .array(z.looseObject({ vendorId: z.number().optional(), deviceId: z.number().optional() }))
      .default([]),
    featureStatus: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** Microsoft's software rasterizer (WARP), which Windows reports when no GPU driver is usable. */
const basicRender = { vendorId: 0x1414, deviceId: 0x8c };

/** Whether Chrome's `SystemInfo.getInfo` says it draws without a GPU. Unknown input: no. */
export function softwareCompositing(info: unknown): boolean {
  const parsed = GpuInfo.safeParse(info);
  if (!parsed.success) return false;
  const { devices, featureStatus } = parsed.data.gpu;
  const compositing = featureStatus?.["gpu_compositing"];
  if (typeof compositing === "string" && compositing !== "enabled") return true;
  return (
    devices.length > 0 &&
    devices.every(
      (device) =>
        device.vendorId === basicRender.vendorId && device.deviceId === basicRender.deviceId,
    )
  );
}

/** ace's Chrome's device scale on Windows: 1 where it draws without a GPU, else `preferred`. */
export function windowsDeviceScale(info: unknown, preferred: number): number {
  return softwareCompositing(info) ? 1 : preferred;
}
