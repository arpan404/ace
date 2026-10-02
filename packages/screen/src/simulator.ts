import { probeOutput } from "@ace/provider-kit/process";
import { z } from "zod";
const Device = z.object({
  udid: z.string().uuid(),
  name: z.string().max(256),
  state: z.string().max(64),
  isAvailable: z.boolean(),
});
const Devices = z.object({ devices: z.record(z.string(), z.array(Device).max(1024)) });
export type Simulator = z.infer<typeof Device> & { runtime: string };
export class Simulators {
  private readonly probe: typeof probeOutput;
  private readonly platform: string;
  private active = 0;
  private async runProbe(
    command: string,
    args: readonly string[],
    options?: Parameters<typeof probeOutput>[2],
  ) {
    if (this.active >= 4) throw new Error("Simulator operation limit");
    this.active++;
    try {
      return await this.probe(command, args, options);
    } finally {
      this.active--;
    }
  }
  constructor(platform: string, probe: typeof probeOutput = probeOutput) {
    this.platform = platform;
    this.probe = probe;
  }
  async list(): Promise<Simulator[]> {
    if (this.platform !== "darwin") return [];
    const output = await this.runProbe("xcrun", ["simctl", "list", "devices", "--json"], {
      maxBytes: 1024 * 1024,
    });
    if (output.code !== 0) throw new Error("Simulator discovery failed");
    return Object.entries(Devices.parse(JSON.parse(output.stdout)).devices).flatMap(
      ([runtime, devices]) =>
        devices
          .filter((device) => device.isAvailable)
          .map((device) => Object.assign(device, { runtime })),
    );
  }
  async boot(input: string): Promise<void> {
    const udid = z.string().uuid().parse(input);
    const device = (await this.list()).find((candidate) => candidate.udid === udid);
    if (!device) throw new Error("Unknown available simulator");
    if (device.state !== "Booted") {
      if ((await this.runProbe("xcrun", ["simctl", "boot", udid])).code !== 0)
        throw new Error("Simulator boot failed");
    }
    if (
      (await this.runProbe("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", udid]))
        .code !== 0
    )
      throw new Error("Simulator window launch failed");
  }
}
