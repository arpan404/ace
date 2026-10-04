import { dirname, basename } from "node:path";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import type { ServicePlan } from "./plan.ts";
import { assertCompatibleHome, installedVersion } from "./home.ts";
import { assertRegistration, incompatibleService } from "./service-identity.ts";

/** A bounded, no-follow registration read; missing registration never authorizes a loaded service. */
export function readRegistration(plan: ServicePlan): string | undefined {
  let directory: PinnedDirectory | undefined;
  try {
    directory = PinnedDirectory.atBoundary(dirname(plan.file));
    return directory.readText(basename(plan.file), 64 * 1024);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw incompatibleService(plan, error);
  } finally {
    directory?.closeSync();
  }
}
export async function assertCompatibleService(plan: ServicePlan, root: string): Promise<void> {
  assertCompatibleHome(root);
  const content = readRegistration(plan);
  if (content === undefined) return;
  installedVersion(root);
  assertRegistration(plan, content);
}
