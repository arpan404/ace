import { readFile } from "node:fs/promises";
import type { ServicePlan } from "./plan.ts";
import { assertCompatibleHome, installedVersion } from "./home.ts";

function program(plan: ServicePlan, content: string): string | undefined {
  return plan.platform === "darwin"
    ? /<key>ProgramArguments<\/key>\s*(<array>.*?<\/array>)/s.exec(content)?.[1]
    : /^ExecStart=(.*)$/m.exec(content)?.[1];
}

/** Validate installation metadata and the registered command without executing it. */
export async function assertCompatibleService(plan: ServicePlan, root: string): Promise<void> {
  assertCompatibleHome(root);
  let content: string;
  try {
    content = await readFile(plan.file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  installedVersion(root);
  const expected = program(plan, plan.content);
  if (!expected || program(plan, content) !== expected)
    throw new Error(
      `Incompatible or legacy ace service at ${plan.file}. Refusing to adopt, start or modify it. Choose a separate ACE_HOME; leave migration to the owner.`,
    );
}
