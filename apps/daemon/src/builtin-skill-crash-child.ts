import { z } from "zod";
import { prepareBuiltinSkills } from "@ace/plugins";
import { spawnSupervised } from "@ace/provider-kit/process";
import { processIdentity } from "@ace/provider-kit/process-identity";
import { createBuiltinSkillRoot } from "./builtin-skill-roots.ts";
import { builtinSkillProcessLease } from "./builtin-skill-processes.ts";

// Local Node fixture only. SIGKILL bypasses provider-kit's in-memory group cleanup.
const dataDir = z.string().min(1).parse(process.argv[2]);
const root = await createBuiltinSkillRoot(dataDir);
await prepareBuiltinSkills("codex", root);
const provider = spawnSupervised({
  command: process.execPath,
  args: ["-e", "setInterval(() => {}, 1000)"],
  env: {},
  name: "skill-crash-fixture",
  lease: builtinSkillProcessLease(root),
});
if (!provider.pid) throw new Error("Fixture provider was not spawned");
const identity = processIdentity(provider.pid);
if (!identity) throw new Error("Fixture provider exited before publication");
process.send?.({ root, identity });
