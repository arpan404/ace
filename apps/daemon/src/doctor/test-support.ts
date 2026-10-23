import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../config.ts";
import type { DoctorContext } from "./feature.ts";

/**
 * A doctor context over a fresh temp data folder, a fixed clock and no daemon. Override
 * any field; pass `daemon` to stand in for a running daemon's client.
 */
export async function doctorTestContext(
  overrides: Partial<DoctorContext> = {},
): Promise<{ context: DoctorContext; dataDir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ace-doctor-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { mode: 0o700 });
  const config = readConfig({ ACE_HOME: dataDir, HOME: root }, root);
  const context: DoctorContext = {
    config,
    env: { HOME: root, PATH: "" },
    home: root,
    platform: process.platform,
    now: () => 1_800_000_000_000,
    daemonState: "stopped",
    daemon: async () => undefined,
    ...overrides,
  };
  return { context, dataDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}
