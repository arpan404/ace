import { useSidebarThread } from "@ace/client-react";
import {
  describeProviderError,
  modelLabel,
  providerNames,
  resultLead,
  type DelegationResult,
} from "@ace/ui-core";
import { CheckCircleIcon, StopCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { ModelFacing } from "./model-facing.tsx";

const outcomes = {
  completed: { icon: CheckCircleIcon, label: "Completed", tone: "text-status-done" },
  failed: { icon: XCircleIcon, label: "Failed", tone: "text-status-failed" },
  cancelled: { icon: StopCircleIcon, label: "Stopped", tone: "text-subtle-foreground" },
} as const;

/**
 * Delegated work coming back (IR-8): one row per child with its outcome, name, provider and
 * model, and the first line of its result; never the JSON the parent model received, which
 * stays behind "What the agent received".
 */
export function DelegationCard(props: { results: readonly DelegationResult[]; received?: string }) {
  const done = props.results.length;
  return (
    <section
      aria-label="Delegated work finished"
      className="rounded-lg px-4 py-3 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <p className="text-xs text-subtle-foreground">
        Delegated work finished{done > 1 ? ` · ${done} threads` : ""}
      </p>
      <ul className="mt-1.5 flex flex-col gap-2">
        {props.results.map((result) => (
          <ResultRow key={result.threadId} result={result} />
        ))}
      </ul>
      {props.received && <ModelFacing text={props.received} className="mt-2" />}
    </section>
  );
}

function ResultRow(props: { result: DelegationResult }) {
  const { result } = props;
  const thread = useSidebarThread(result.threadId);
  const outcome = outcomes[result.outcome];
  const Glyph = outcome.icon;
  const model = thread?.execution?.model;
  const lead =
    result.outcome === "failed"
      ? describeProviderError({ text: result.result, provider: thread?.provider, model }).title
      : resultLead(result.result);
  return (
    <li className="flex items-start gap-2.5">
      <Glyph aria-label={outcome.label} size={16} className={`mt-0.5 shrink-0 ${outcome.tone}`} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 text-ui">
          <span className="truncate font-medium">{thread?.title ?? "Delegated thread"}</span>
          {thread && (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-subtle-foreground">
              <ProviderIcon provider={thread.provider} model={model} size={12} decorative />
              {providerNames[thread.provider]}
              {model ? ` · ${modelLabel(model)}` : ""}
            </span>
          )}
          <Link
            to="/t/$threadId"
            params={{ threadId: result.threadId }}
            className="ml-auto shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Open thread
          </Link>
        </p>
        {lead && (
          <p
            className={`mt-0.5 line-clamp-2 text-sm ${result.outcome === "failed" ? "text-status-failed" : "text-muted-foreground"}`}
          >
            {lead}
          </p>
        )}
      </div>
    </li>
  );
}
