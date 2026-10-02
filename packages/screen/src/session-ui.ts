import {
  ScreenUITreeOptions,
  ScreenUIFindOptions,
  ScreenUIActOptions,
  ScreenUIActResult,
} from "@ace/protocol";
import type { Helper } from "./helper.ts";
import type { Session } from "./session.ts";
import { parseUITree, parseUIFind } from "./ui-results.ts";
type Controlled = <T>(
  id: string,
  actor: "human" | "agent",
  owner: string,
  command: (helper: Helper) => Promise<T>,
) => Promise<T>;
/** Session authorization and serialized ownership checks are supplied by the manager. */
export class SessionUI {
  private readonly read: (id: string, owner: string) => Session;
  private readonly controlled: Controlled;
  constructor(read: (id: string, owner: string) => Session, controlled: Controlled) {
    this.read = read;
    this.controlled = controlled;
  }
  async tree(id: string, options: unknown, owner: string): Promise<unknown> {
    const session = this.read(id, owner);
    if (!session.helper.capabilities?.uiTree) throw new Error("Helper does not support UI trees");
    const epoch = session.epoch;
    const caps = ScreenUITreeOptions.parse(options);
    const result = await session.helper.requestV2({
      op: "ui.tree",
      target: session.state.target,
      ...caps,
    });
    this.verifyRead(id, owner, session, epoch);
    return parseUITree(result, caps.maxNodes, caps.maxDepth);
  }
  async find(id: string, options: unknown, owner: string): Promise<unknown> {
    const session = this.read(id, owner);
    if (!session.helper.capabilities?.uiTree) throw new Error("Helper does not support UI trees");
    const epoch = session.epoch;
    const query = ScreenUIFindOptions.parse(options);
    const result = await session.helper.requestV2({ op: "ui.find", ...query });
    this.verifyRead(id, owner, session, epoch);
    return parseUIFind(result, query.limit);
  }
  private verifyRead(id: string, owner: string, session: Session, epoch: number): void {
    if (this.read(id, owner) !== session || session.epoch !== epoch)
      throw new Error("Controller changed during UI read");
  }
  async act(
    id: string,
    options: unknown,
    owner: string,
    actor: "human" | "agent",
  ): Promise<unknown> {
    const action = ScreenUIActOptions.parse(options);
    const session = this.read(id, owner);
    if (!session.helper.capabilities?.semanticActions.includes(action.action))
      throw new Error("Semantic action not supported");
    return this.controlled(id, actor, owner, async (helper) =>
      ScreenUIActResult.parse(await helper.requestV2({ op: "ui.act", ...action })),
    );
  }
  async key(
    id: string,
    key: string,
    modifiers: ("control" | "shift" | "alt" | "meta")[],
    owner: string,
  ): Promise<void> {
    await this.controlled(id, "agent", owner, (helper) =>
      helper.requestV2({ op: "key.press", key, modifiers }),
    );
  }
}
