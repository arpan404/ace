import {
  MergeResponse,
  PreparedWorkspace,
  PullRequestResponse,
  VerificationResponse,
} from "./responses.ts";
import { Effect, Fact } from "./schema.ts";
import type { Executor, Ports } from "./ports.ts";

export function executor(ports: Ports): Executor {
  return async (input) => {
    const effect = Effect.parse(input);
    let results: unknown[] = [];
    switch (effect.type) {
      case "cleanup":
        await ports.git.cleanup(effect.id, effect.runId);
        break;
      case "launch": {
        const prepared = PreparedWorkspace.parse(
          await ports.git.prepare(
            `${effect.id}.git`,
            effect.workspaceId,
            effect.lane,
            effect.completion,
            effect.dependencies,
          ),
        );
        // Root attachment precedes execution so there are no invisible lanes.
        await ports.orchestrator.attach(`${effect.id}.attach`, effect.rootAgentId, effect.lane);
        if (effect.lane.source)
          await ports.engine.fork(
            effect.id,
            effect.lane,
            effect.lane.source,
            prepared.cwd,
            effect.prompt,
          );
        else await ports.engine.start(effect.id, effect.lane, prepared.cwd, effect.prompt);
        break;
      }
      case "migrate":
        await ports.accounts.migrate(effect.id, effect.lane, effect.fromAccount);
        results = [
          { type: "migrated", laneId: effect.lane.id, generation: effect.lane.generation },
        ];
        break;
      case "control":
        results = await ports.engine.control(effect.id, effect.lane, effect.action);
        break;
      case "gate":
        await ports.interactions.open(effect.id, effect.rootAgentId, effect.gate);
        break;
      case "gate_closed":
        await ports.interactions.close(effect.id, effect.gateId);
        break;
      case "merge": {
        const merged =
          effect.mode === "pr"
            ? {
                ...PullRequestResponse.parse(
                  await ports.forge.openPR(effect.id, effect.completion),
                ),
                conflict: null,
                trivial: false,
              }
            : MergeResponse.parse(await ports.git.merge(effect.id, effect.completion));
        results = [
          {
            ...merged,
            type: "merge_result",
            operationId: effect.id,
            workstream: effect.workstream,
          },
        ];
        break;
      }
      case "verify": {
        const result = VerificationResponse.parse(
          effect.mode === "pr"
            ? await ports.forge.verifyCI(effect.id, effect.revision)
            : await ports.verification.check(effect.id, effect.revision),
        );
        results = [
          {
            ...result,
            type: "verified",
            operationId: effect.id,
            workstream: effect.workstream,
            revision: effect.revision,
          },
        ];
        break;
      }
    }
    return results.map((r) => Fact.parse(r));
  };
}
