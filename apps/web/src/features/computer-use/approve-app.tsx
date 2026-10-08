import { ScreenInventory } from "@ace/protocol";
import { appName } from "@ace/ui-core/computer-use";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import type { ComputerUse } from "./use-computer-use.ts";

/** Only the person can grant browser native UI access. No persistent grant is offered. */
export function ApproveApp(props: { use: ComputerUse; threadId: string; onApproved(): void }) {
  const { use, threadId } = props;
  const [apps, setApps] = useState<readonly { value: string; label: string }[]>();
  const [selected, setSelected] = useState("");
  const [problem, setProblem] = useState<string>();
  const [loading, setLoading] = useState(false);
  const choose = async () => {
    if (!use.session) return;
    setLoading(true);
    setProblem(undefined);
    try {
      const inventory = ScreenInventory.parse(await use.session.request({ op: "targets" }));
      const bundles = [...new Set(inventory.windows.map((window) => window.bundleId))];
      setApps(bundles.map((bundle) => ({ value: bundle, label: appName(bundle) })));
    } catch {
      setProblem("Couldn't read open apps. Try again.");
    } finally {
      setLoading(false);
    }
  };
  const approve = async () => {
    if ((await use.approveApp(selected, threadId)) === undefined) return;
    setSelected("");
    setApps(undefined);
    props.onApproved();
  };
  return (
    <div className="mb-3 flex flex-col gap-2">
      <p className="text-xs text-subtle-foreground">
        Use ace's browser for websites. To allow computer use of an app's native UI, approve it here
        for this thread.
      </p>
      {apps === undefined ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={!use.snapshot.connected || !use.snapshot.enabled || loading}
          onClick={() => void choose()}
        >
          {loading ? "Reading apps…" : "Approve an app"}
        </Button>
      ) : (
        <>
          <Select
            label="App to approve"
            value={selected}
            options={[{ value: "", label: "Choose an open app" }, ...apps]}
            onValueChange={setSelected}
            disabled={use.pending}
          />
          {apps.length === 0 && (
            <p role="status" className="text-xs text-subtle-foreground">
              Open the app, then refresh the list.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!selected || use.pending || !use.snapshot.enabled}
              onClick={() => void approve()}
            >
              Allow for this thread
            </Button>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void choose()}>
              Refresh apps
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setApps(undefined)}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {problem && (
        <p role="alert" className="text-xs text-status-failed">
          {problem}
        </p>
      )}
    </div>
  );
}
