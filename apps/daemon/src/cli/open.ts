import type { Config } from "../config.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { selectedProfile } from "./profiles.ts";
import { connectCli } from "./connection.ts";
import { addProject, getProject, projectPath } from "./projects.ts";
import { key } from "./mutations.ts";
import { mutationResult } from "./io.ts";
import { CliFailure } from "./output.ts";
import { ensureDaemon, opener, systemOpenRuntime, type OpenRuntime } from "./open-runtime.ts";
export async function openCommand(
  args: Args,
  config: Config,
  runtime: OpenRuntime = systemOpenRuntime(),
) {
  const projectVerb = args.words[0] === "project";
  validateArgs(args, ["web", "idempotency-key"], projectVerb ? 3 : 1, projectVerb ? 3 : 2);
  const profile = selectedProfile(config.dataDir, option(args, "remote"));
  if (!profile) await ensureDaemon(config.dataDir, args, runtime);
  const session = await connectCli(config.dataDir, args);
  try {
    const id = key(args);
    const project = projectVerb
      ? await getProject(session.client, args.words[2] ?? "", session.signal)
      : (
          await addProject(
            session.client,
            projectPath(args.words[1], session.remote, process.cwd()),
            id,
            session.signal,
          )
        ).workspace;
    if (!project)
      throw new CliFailure("uncertain", "Project identity unavailable", { idempotencyKey: id });
    const web = new URL("/new", session.origin);
    web.searchParams.set("project", project.id);
    const desktop = new URL("ace://open");
    desktop.searchParams.set("folder", project.path);
    let target = args.flags.web || session.remote ? web.href : desktop.href;
    const dispatch = async () => {
      const plan = opener(runtime.platform, target);
      return runtime.open(plan.command, plan.args);
    };
    let opened = await dispatch().catch(() => ({ code: 1 }));
    if (opened.code !== 0 && target !== web.href) {
      target = web.href;
      opened = await dispatch().catch(() => ({ code: 1 }));
    }
    if (opened.code !== 0)
      throw new CliFailure("needs-human", `Open ${target} to view this project`, {
        project,
        idempotencyKey: id,
      });
    return mutationResult(args, { accepted: true, project, target, idempotencyKey: id });
  } finally {
    await session.close();
  }
}
