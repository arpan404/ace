import { registerPiTurnBoundaries } from "./turn-boundary.ts";
import { registerPiContextSamples } from "./context-usage.ts";
import { z } from "zod";
import { readPrivateMcpConfig, AceMcpConnectionSchema } from "@ace/mcp-server";
import { registerAceMcpTools } from "./extension-mcp.ts";
import type { PiExtensionApi } from "./extension-api.ts";

/** Where the session file's path is kept once it leaves the environment, for Pi's reloads. */
export interface PiSessionFileHolder {
  sessionFile?: string;
}
const holderKey = Symbol.for("ace.pi.session-file");
/** One holder per Pi process: in its memory, never in an environment a child inherits. */
function processHolder(): PiSessionFileHolder {
  const existing: unknown = Reflect.get(globalThis, holderKey);
  if (existing && typeof existing === "object") return existing;
  const holder: PiSessionFileHolder = {};
  Reflect.set(globalThis, holderKey, holder);
  return holder;
}

/**
 * Runs inside installed Pi. All provider auth remains Pi-owned. Pi rejects action methods while
 * this factory runs, so it only reads its session file and registers commands and hooks.
 * Pi runs the factory again whenever it replaces the session (switch_session, fork, clone,
 * reload), so the session file's path outlives the first load; ace removes the file itself
 * when the session ends.
 */
export default async function aceExtension(
  pi: PiExtensionApi,
  env: NodeJS.ProcessEnv = process.env,
  holder: PiSessionFileHolder = processHolder(),
): Promise<void> {
  const file = z.string().parse(env.ACE_PI_SESSION_FILE ?? holder.sessionFile);
  // Pi shell tools inherit this process's environment, so the path leaves it on first load.
  delete env.ACE_PI_SESSION_FILE;
  holder.sessionFile = file;
  const session = z
    .object({
      controlSecret: z.string().regex(/^[a-f0-9]{64}$/),
      mcp: AceMcpConnectionSchema.optional(),
    })
    .parse(JSON.parse(readPrivateMcpConfig(file)));
  const secret = session.controlSecret;
  registerPiContextSamples(pi);
  registerPiTurnBoundaries(pi);
  pi.registerCommand("ace-rollback", {
    description: "ace conversation navigation",
    async handler(args, ctx) {
      const [supplied, id, requestId, ...rest] = args.split(" ");
      if (supplied !== secret || !id || !requestId || rest.length || !/^[-a-zA-Z0-9_]+$/.test(id))
        throw new Error("Unauthorized ace navigation");
      try {
        await ctx.waitForIdle();
        const result = await ctx.navigateTree(id, { summarize: false });
        if (!result.cancelled) pi.appendEntry("ace-navigation", { targetId: id });
        ctx.ui.notify(
          JSON.stringify({ type: "ace_rollback", id: requestId, success: !result.cancelled }),
          "info",
        );
      } catch {
        ctx.ui.notify(
          JSON.stringify({ type: "ace_rollback", id: requestId, success: false }),
          "error",
        );
      }
    },
  });
  pi.registerCommand("ace-context", {
    description: "ace-originated delegation context",
    async handler(args) {
      const [supplied, encoded, ...rest] = args.split(" ");
      if (
        supplied !== secret ||
        !encoded ||
        rest.length ||
        encoded.length > 800000 ||
        !/^[A-Za-z0-9+/=]+$/.test(encoded)
      )
        throw new Error("Unauthorized ace context");
      if (!pi.sendMessage) throw new Error("Pi custom context is unavailable");
      const content = Buffer.from(encoded, "base64").toString("utf8");
      pi.sendMessage(
        {
          customType: "ace.delegation.settled",
          content,
          display: false,
          details: { origin: "ace" },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });
  if (session.mcp) registerAceMcpTools(pi, session.mcp);
}
