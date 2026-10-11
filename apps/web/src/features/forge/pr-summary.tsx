import { useState, type ReactNode } from "react";
import {
  CaretDownIcon,
  PencilSimpleIcon,
  TagIcon,
  UsersIcon,
  UserPlusIcon,
  ArrowSquareOutIcon,
} from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { openExternal } from "@/boot/open-external.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { PrMarkdown } from "./pr-markdown.tsx";
import { PrAvatar, PrTime } from "./pr-presentation.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";

export function PrSection(props: { title: string; children: ReactNode; action?: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <h3>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-2 rounded-sm text-sm font-medium text-muted-foreground focus-ring"
          >
            {props.title}
            <CaretDownIcon aria-hidden size={12} className={open ? "" : "-rotate-90"} />
          </button>
        </h3>
        {props.action}
      </div>
      {open && props.children}
    </section>
  );
}
export function PrSummary(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  onReviewers(): void;
  onOpen(number: number): void;
}) {
  const { detail } = props.context;
  const toast = useToast();
  return (
    <div className="space-y-7 px-5 pt-4 pb-20">
      <dl className="space-y-4 text-sm">
        <div className="flex items-center gap-3">
          <dt className="flex w-28 shrink-0 items-center gap-2 text-muted-foreground">
            <UsersIcon aria-hidden size={16} />
            Reviewers
          </dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-2">
            {detail.reviewers.length ? (
              detail.reviewers.map((name) => (
                <span key={name} title={name}>
                  <PrAvatar name={name} url={detail.reviewerAvatars?.[name]} />
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
            {props.extensions?.reviewers?.(props.context) ??
              (detail.relatedThreads.length > 0 && (
                <IconButton
                  icon={UserPlusIcon}
                  label="Add reviewer"
                  size="sm"
                  disabled={props.context.disabled || detail.status.state !== "open"}
                  onClick={props.onReviewers}
                />
              ))}
          </dd>
        </div>
        <div className="flex items-center gap-3">
          <dt className="flex w-28 shrink-0 items-center gap-2 text-muted-foreground">
            <TagIcon aria-hidden size={16} />
            Labels
          </dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-2">
            {detail.labels.length ? (
              detail.labels.map((label) => (
                <span key={label} className="rounded-sm bg-accent px-2 py-0.5 text-xs">
                  {label}
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
            {props.extensions?.labels?.(props.context)}
          </dd>
        </div>
      </dl>
      <PrSection
        title="Description"
        action={
          props.extensions?.editDescription && (
            <IconButton
              icon={PencilSimpleIcon}
              label="Edit description"
              size="sm"
              className="ml-auto"
              disabled={props.context.disabled}
              onClick={() => props.extensions?.editDescription?.(props.context)}
            />
          )
        }
      >
        <PrMarkdown
          context={props.context}
          extensions={props.extensions}
          onOpen={props.onOpen}
          text={detail.body || "No description provided."}
        />
      </PrSection>
      {props.extensions?.summary?.(props.context)}
      <PrSection title="Checks">
        {detail.status.checks.length ? (
          <ul className="divide-y divide-border">
            {detail.status.checks.map((check) => (
              <li key={check.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1 break-words">{check.name}</span>
                <span>{check.status}</span>
                {check.url && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Open ${check.name}`}
                    onClick={() =>
                      check.url &&
                      void openExternal(check.url).catch(() =>
                        toast.error({ title: "Couldn't open the check" }),
                      )
                    }
                  >
                    <ArrowSquareOutIcon aria-hidden size={14} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No checks reported.</p>
        )}
      </PrSection>
      <PrSection title={`Comments (${detail.status.comments.length})`}>
        {detail.status.comments.length ? (
          <ol className="space-y-5">
            {detail.status.comments.map((comment) => (
              <li key={`${comment.kind}:${comment.id}`} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <PrAvatar name={comment.author} url={comment.authorAvatarUrl} />
                  <span className="font-medium">{comment.author}</span>
                  <span className="text-muted-foreground">
                    {comment.kind === "review"
                      ? comment.reviewState
                      : comment.kind === "inline"
                        ? `${comment.file}:${comment.line ?? ""}`
                        : "commented"}
                  </span>
                  <PrTime at={comment.createdAt ?? comment.updatedAt} />
                </div>
                <Prose text={comment.body} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        )}
      </PrSection>
      {detail.status.reviewThreads.length > 0 && (
        <PrSection title="Review threads">
          <div className="space-y-3">
            {detail.status.reviewThreads.map((thread) => (
              <details key={thread.id}>
                <summary className="cursor-pointer rounded-sm text-sm focus-ring">
                  {thread.file}:{thread.line ?? ""} · {thread.resolved ? "Resolved" : "Unresolved"}
                  {thread.outdated ? " · Outdated" : ""}
                </summary>
                {thread.comments.map((comment) => (
                  <div key={comment.id} className="mt-2 border-l border-border pl-4">
                    <p className="text-sm">{comment.author}</p>
                    <Prose text={comment.body} />
                  </div>
                ))}
              </details>
            ))}
          </div>
        </PrSection>
      )}
    </div>
  );
}
