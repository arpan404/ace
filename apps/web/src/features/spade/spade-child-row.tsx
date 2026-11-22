import { subagentRunning, type SubagentState } from "@ace/ui-core";
import {
  AgentRowContents,
  agentRowStyles,
  SubagentElapsed,
  SubagentSection,
  type AgentRowParts,
} from "@/features/thread/index.ts";
import { useLive } from "@/lib/live-connection.ts";

/*
 * A helper (ADR 0152) or a call to another bot's contract (ADR 0200 §7) as the child it is, drawn
 * with ace's own child row: its mark, its name and what it is, its state in words with how long
 * it has run, and what it does now or found. Opens the bot's Work tab, where its log is. One that
 * waits on the person reads Needs you, never done while it hasn't ended (AGENTS.md priority 1).
 */
export function SpadeChildRow(props: {
  name: string;
  /** What it is beside its name ("Contract"), when the name doesn't say. */
  meta?: string | undefined;
  state: SubagentState;
  /** Spade's words for it: what it looks into, or what it found. */
  detail: string;
  startedAt: number | undefined;
  onOpen: (() => void) | undefined;
}) {
  // The chat's own facts: current while the conversation is.
  const live = useLive(true);
  const parts: AgentRowParts = {
    mark: {},
    name: props.name,
    meta: props.meta,
    state: props.state,
    live,
    elapsed: props.startedAt !== undefined && subagentRunning(props.state) && (
      <SubagentElapsed startedAt={props.startedAt} running fresh />
    ),
    detail: props.detail,
    detailKind:
      props.state === "human"
        ? "human"
        : props.state === "failed"
          ? "failed"
          : subagentRunning(props.state)
            ? "live"
            : "result",
  };
  return (
    <div className="w-full max-w-150 min-w-0 px-(--chat-bubble-x)">
      <SubagentSection states={[props.state]} fresh folded={false}>
        <ul aria-label="Subagents">
          <li data-subagent-state={props.state} className="relative">
            <button
              type="button"
              aria-label={`Open ${props.name}`}
              className={agentRowStyles.box}
              onClick={props.onOpen}
            >
              <AgentRowContents {...parts} />
            </button>
          </li>
        </ul>
      </SubagentSection>
    </div>
  );
}
