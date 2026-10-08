import { Textarea } from "@/components/ui/input.tsx";
import { useEffect, useRef, useState } from "react";
import { SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent } from "@/components/ui/dialog.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { PluginReviewStep } from "./plugin-review.tsx";
import {
  useCancelReview,
  useEditPlugin,
  useSkillSource,
  type PreparedPlugin,
} from "./skills-source.ts";
import { skillMarkdown, type Skill } from "./skills-model.ts";
import { Prose } from "@/components/markdown/prose.tsx";

export function SkillSource({ skill }: { skill: Skill }) {
  const source = useSkillSource(skill);
  const edit = useEditPlugin();
  const cancel = useCancelReview();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [accepting, setAccepting] = useState(false);
  const [review, setReview] = useState<PreparedPlugin>();
  const editingHash = useRef<string>(undefined);
  const abort = useRef<AbortController>(null);
  const pendingReview = useRef<PreparedPlugin>(undefined);
  const drop = useRef(cancel.mutate);
  useEffect(() => {
    drop.current = cancel.mutate;
  }, [cancel.mutate]);
  useEffect(
    () => () => {
      abort.current?.abort();
      if (pendingReview.current) drop.current(pendingReview.current.review.id);
    },
    [],
  );
  const closeReview = () => {
    if (accepting) return;
    if (review) cancel.mutate(review.review.id);
    pendingReview.current = undefined;
    setReview(undefined);
  };
  const save = async () => {
    if (!source.data || !editingHash.current || draft === undefined || !skill.path) return;
    setError(undefined);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const next = await edit.mutateAsync({
        name: skill.plugin,
        path: skill.path,
        expectedHash: editingHash.current,
        text: draft,
        signal: controller.signal,
      });
      pendingReview.current = next;
      setReview(next);
    } catch {
      if (!controller.signal.aborted)
        setError(
          "Couldn't save this source. It may have changed or contain an invalid plugin definition. Reload the source and try again.",
        );
    }
  };
  return (
    <SettingSection label="Source">
      <p className="break-words font-mono text-sm text-muted-foreground">{skill.path}</p>
      {source.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn't read the source.{" "}
          <Button variant="ghost" size="sm" onClick={() => void source.refetch()}>
            Try again
          </Button>
        </p>
      ) : !source.data ? (
        <SkeletonText lines={4} />
      ) : (
        <>
          <div className="flex h-9 items-center justify-end gap-2">
            {draft === undefined ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={source.data.bytes > 262144}
                onClick={() => {
                  editingHash.current = source.data.hash;
                  setDraft(source.data.text);
                }}
              >
                Edit
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={edit.isPending}
                  onClick={() => {
                    setDraft(undefined);
                    setError(undefined);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={
                    edit.isPending ||
                    draft === source.data.text ||
                    new TextEncoder().encode(draft).length > 262144
                  }
                  onClick={() => void save()}
                >
                  {edit.isPending ? "Saving…" : "Save"}
                </Button>
              </>
            )}
          </div>
          {source.data.bytes > 262144 && (
            <p className="text-sm text-muted-foreground">
              This source is too large to edit here. Open it in your editor.
            </p>
          )}
          {draft === undefined && skill.kind === "skill" ? (
            <Prose text={skillMarkdown(source.data.text, skill)} />
          ) : draft === undefined ? (
            <pre className="overflow-auto font-mono text-sm leading-normal whitespace-pre-wrap break-words">
              {source.data.text}
            </pre>
          ) : (
            <Textarea
              aria-label="Source text"
              value={draft}
              readOnly={edit.isPending}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              className="min-h-64 font-mono text-sm"
            />
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setError(undefined);
                  setDraft(undefined);
                  void source.refetch();
                }}
              >
                Reload source
              </Button>
            </p>
          )}
        </>
      )}
      <Dialog
        open={review !== undefined}
        onOpenChange={(open) => {
          if (!open) closeReview();
        }}
      >
        <DialogContent size="md">
          {review && (
            <PluginReviewStep
              action="Accept changes"
              onAcceptingChange={setAccepting}
              prepared={review}
              onBack={closeReview}
              onInstalled={() => {
                pendingReview.current = undefined;
                setReview(undefined);
                setDraft(undefined);
                void source.refetch();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </SettingSection>
  );
}
