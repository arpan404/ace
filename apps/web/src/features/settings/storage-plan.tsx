import { useState } from "react";
import type { StorageApply, StorageCompaction, StoragePlan } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { SettingSection } from "@/components/setting-row.tsx";
import { storageBytes, storageReasons } from "./storage-copy.ts";

export function StoragePlanPreview(props: {
  plan: StoragePlan;
  result?: StorageApply | undefined;
  busy: boolean;
  disabled: boolean;
  forceItems: string[];
  onForce(id: string, selected: boolean): void;
  onApply(): void;
}) {
  const [confirm, setConfirm] = useState(false);
  const remove = props.plan.items.filter((item) => item.disposition === "remove");
  const protectedItems = props.plan.items.filter((item) => item.disposition === "protect");
  const finished = props.result?.state === "complete" || props.result?.state === "stale";
  return (
    <SettingSection label="Cleanup preview">
      <p className="mb-3 text-sm text-muted-foreground">
        {remove.length} items to remove · {storageBytes(props.plan.bytes)} of data.{" "}
        {protectedItems.length} protected.
      </p>
      {!props.plan.complete && (
        <p className="mb-3 text-sm text-muted-foreground">
          This is a bounded batch. Preview again after cleanup to find more data.
        </p>
      )}
      <ul aria-label="Cleanup items" className="divide-y divide-border">
        {props.plan.items.map((item) => {
          const forceable =
            item.kind === "worktrees" &&
            item.disposition === "protect" &&
            item.reasons.every((reason) => ["uncommitted", "unpushed"].includes(reason));
          const result = props.result?.items.find((entry) => entry.id === item.id);
          return (
            <li key={item.id} className="py-3">
              <div className="flex items-start justify-between gap-3 text-sm">
                <span className="min-w-0 break-all font-medium">{item.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {storageBytes(item.bytes)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {item.disposition === "remove" ? "Remove" : "Keep"} ·{" "}
                {item.reasons.map((reason) => storageReasons[reason]).join("; ")}
                {item.forced ? " · Forced for this item" : ""}
                {item.removeBranch ? ` · Also remove branch ${item.branch ?? ""}` : ""}
              </p>
              {item.effects.includes("browser_data") && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Also clears this thread's attachment references and browser data, including its
                  desktop browser partition.
                </p>
              )}
              {result && (
                <p className="mt-1 text-xs" role="status">
                  {result.state === "removed"
                    ? "Removed"
                    : result.state === "protected"
                      ? `Kept: ${storageReasons[result.reason ?? "changed"]}`
                      : "Cleanup pending. Resume to retry."}
                </p>
              )}
              {forceable && (
                <label className="mt-2 flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={props.forceItems.includes(item.id)}
                    disabled={props.busy || props.disabled}
                    onChange={(event) => props.onForce(item.id, event.target.checked)}
                  />
                  Include this worktree despite uncommitted or unpushed work
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {!props.plan.items.length && (
        <p className="text-sm text-muted-foreground">
          No data was found in these storage categories.
        </p>
      )}
      {props.result?.state === "stale" && (
        <p role="alert" className="mt-3 text-sm">
          This plan changed. Preview cleanup again before removing data.
        </p>
      )}
      {props.result?.state === "complete" && (
        <p role="status" className="mt-3 text-sm">
          Cleanup finished. Items that became protected were kept.
        </p>
      )}
      <Button
        size="sm"
        variant="danger"
        className="mt-4"
        disabled={
          props.busy || props.disabled || finished || !remove.length || props.forceItems.length > 0
        }
        onClick={() => setConfirm(true)}
      >
        {props.busy
          ? "Cleaning…"
          : props.result?.state === "pending"
            ? "Resume cleanup"
            : `Remove ${remove.length} items`}
      </Button>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {remove.length} items?</DialogTitle>
            <DialogDescription>
              The listed data will be permanently removed. ace checks the plan again and keeps
              anything that has changed or is protected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(false);
                props.onApply();
              }}
            >
              Remove items
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingSection>
  );
}

/** Incremental database compaction; there is no full rebuild to confirm. */
export function StorageCompactAction(props: {
  result?: StorageCompaction | undefined;
  busy: boolean;
  disabled: boolean;
  onCompact(): void;
  onAbandon(id: string): void;
}) {
  const result = props.result;
  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={props.busy || props.disabled}
          onClick={props.onCompact}
        >
          {result?.state === "pending" ? "Resume compaction" : "Compact database"}
        </Button>
        {result?.state === "pending" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={props.busy || props.disabled}
            onClick={() => props.onAbandon(result.id)}
          >
            Stop compaction
          </Button>
        )}
      </div>
      {result && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {result.incrementalUnavailable
            ? "This database was created before compaction was available and can't shrink in place."
            : result.state === "complete"
              ? `Compacted from ${storageBytes(result.databaseBytesBefore)} to ${storageBytes(result.databaseBytes)}.`
              : result.state === "pending"
                ? "Compaction paused. Resume to continue."
                : "Compaction stopped."}
        </p>
      )}
    </div>
  );
}
