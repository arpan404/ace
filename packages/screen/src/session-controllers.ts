import { ScreenAgentScope, type ScreenState, type ScreenTarget } from "@ace/protocol";
import { agentOwner, agentScope, ScreenDelegationError } from "./agent-binding.ts";
import { TargetBusyError } from "./target-busy.ts";
import { HelperCommandError } from "./helper.ts";
import { bundles, takeControl } from "./policy.ts";
import type { Session, ControllerBinding } from "./session.ts";
import { releaseControllerBinding } from "./controller-binding.ts";

type ControlPorts = {
  sessions: Map<string, Session>;
  live(id: string): Session;
  authorize(target: ScreenTarget, scope?: ScreenAgentScope): void;
  paused(): boolean;
  emit(session: Session): void;
  releaseUnused(session: Session): void;
};
/** Controller ownership and consent reset are independent of capture lifetimes. */
export class SessionControllers {
  private readonly sessions: Map<string, Session>;
  private readonly live: ControlPorts["live"];
  private readonly authorize: ControlPorts["authorize"];
  private readonly paused: () => boolean;
  private readonly emit: ControlPorts["emit"];
  private readonly releaseUnused: ControlPorts["releaseUnused"];
  constructor(ports: ControlPorts) {
    this.sessions = ports.sessions;
    this.live = ports.live;
    this.authorize = ports.authorize;
    this.paused = ports.paused;
    this.emit = ports.emit;
    this.releaseUnused = ports.releaseUnused;
  }
  delegateAgent(id: string, input: ScreenAgentScope): void {
    input = ScreenAgentScope.parse(input);
    const session = this.live(id);
    this.authorize(session.state.target, input);
    this.controller(id, "agent", agentOwner(input));
    session.approvalScope = input;
    session.state = { ...session.state, holder: input };
    this.emit(session);
  }
  agentSession(input: ScreenAgentScope, requestedId?: string): string {
    if (this.paused())
      throw new HelperCommandError("permission_denied", "Computer use stopped by human");
    input = ScreenAgentScope.parse(input);
    const owner = agentOwner(input);
    const session = [...this.sessions.values()].find(
      (candidate) =>
        (requestedId === undefined || candidate.state.sessionId === requestedId) &&
        candidate.state.lifecycle === "live" &&
        candidate.state.controller === "agent" &&
        candidate.owner === owner,
    );
    if (!session) throw new ScreenDelegationError();
    if (
      requestedId === undefined &&
      [...this.sessions.values()].filter(
        (candidate) =>
          candidate.state.lifecycle === "live" &&
          candidate.state.controller === "agent" &&
          candidate.owner === owner,
      ).length > 1
    )
      throw new Error("Multiple app sessions; pass sessionId");
    session.controllerBinding?.authorize();
    this.authorize(session.state.target, session.approvalScope);
    return session.state.sessionId;
  }
  controller(
    id: string,
    controller: ScreenState["controller"],
    owner = "local",
    binding?: ControllerBinding,
  ): void {
    const session = this.live(id);
    if (controller === "agent" && session.humanView) throw new ScreenDelegationError();
    if (controller === "agent" && session.state.controller === "agent" && session.owner !== owner)
      throw new TargetBusyError(
        bundles(session.state.target).join(","),
        id,
        session.owner ?? "agent",
      );
    if (controller !== "agent")
      session.state = {
        ...session.state,
        holder: undefined,
        mode: "background",
        secureInputAllowed: false,
      };
    if (
      session.pointerDown &&
      session.helper.capabilities?.platform === "macos" &&
      (session.state.controller !== controller || session.owner !== owner)
    ) {
      const cleanup = session.helper.request({ op: "input", input: { kind: "pointer.cancel" } });
      const completion = cleanup.then(() => {
        if (session.pointerCleanup === completion) {
          session.pointerDown = false;
          delete session.pointerCleanup;
        }
      });
      session.pointerCleanup = completion;
      void session.pointerCleanup.catch((error) => {
        session.state.error = String(error);
        this.emit(session);
      });
    }
    if (session.controllerBinding) {
      // No old input remains authorized if an external release callback fails.
      Object.assign(session, takeControl(session, "none", owner));
      const error = releaseControllerBinding(session);
      if (error) {
        this.emit(session);
        this.releaseUnused(session);
        throw error;
      }
    }
    Object.assign(session, takeControl(session, controller, owner));
    if (controller === "agent") {
      const scope = agentScope(owner);
      session.state = { ...session.state, holder: scope };
      session.approvalScope = scope ?? session.approvalScope;
    }
    session.controllerBinding = controller === "none" ? undefined : binding;
    this.emit(session);
    this.releaseUnused(session);
  }
  releaseController(owner: string): void {
    for (const session of this.sessions.values())
      if (session.owner === owner && session.state.lifecycle === "live")
        this.controller(session.state.sessionId, "none");
  }
}
