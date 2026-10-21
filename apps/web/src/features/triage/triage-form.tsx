import { useClient, useConnectionState } from "@ace/client-react";
import { useEffect, useRef, useState, Suspense } from "react";
import type { DiagnosticReport, TriageKind, TriageProvider } from "@ace/protocol";
import { buildTriagePrompt, triageProviders, triageTemplates } from "@ace/diagnostics/triage";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { InteractiveTerminal } from "@/components/interactive-terminal.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { useToast } from "@/components/ui/toast.tsx";

export function TriageForm(props: { report?: DiagnosticReport }) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const [kind, setKind] = useState<TriageKind>(props.report ? "doctor" : "bug");
  const [description, setDescription] = useState(
    props.report ? "Help me resolve the remaining ace doctor findings." : "",
  );
  const [include, setInclude] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [provider, setProvider] = useState<TriageProvider>("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [terminal, setTerminal] = useState<string>();
  const [exit, setExit] = useState<number>();
  const mounted = useRef(true);
  const liveTerminal = useRef<string>(undefined);
  const toast = useToast();
  const copy = useCopy(() => toast.error({ title: "Couldn't copy the prompt" }));
  const stop = async (id: string) => {
    await client
      .request({ type: "terminal.request", operation: { op: "close", terminalId: id } })
      .catch(() => {});
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (liveTerminal.current)
        void client
          .request({
            type: "terminal.request",
            operation: { op: "close", terminalId: liveTerminal.current },
          })
          .catch(() => {});
    };
  }, [client]);
  const generate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      let report = include ? props.report : undefined;
      if (include && !report) {
        const reply = await client.request(
          { type: "diagnostics.request", operation: "doctor" },
          { timeoutMs: 30_000 },
        );
        if (!reply.report || reply.error)
          throw new Error(
            "Couldn't collect diagnostics. Try again or turn off Include diagnostics.",
          );
        report = reply.report;
      }
      if (mounted.current) {
        setPreviewing(true);
        setPrompt(buildTriagePrompt({ kind, description, ...(report ? { report } : {}) }));
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Couldn't generate the prompt. Try again.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const launch = async () => {
    setBusy(true);
    setError(undefined);
    setExit(undefined);
    try {
      const reply = await client.request(
        { type: "diagnostics.request", operation: "launch", provider, prompt },
        { timeoutMs: 30_000 },
      );
      if (!reply.terminalId || reply.error)
        throw new Error(
          reply.error === "forbidden"
            ? "Opening a support CLI requires administrator access to this computer. Copy the prompt to your own CLI instead."
            : "Couldn't open the CLI. Check that it is installed and signed in on the connected computer, or copy the prompt.",
        );
      if (!mounted.current) {
        await stop(reply.terminalId);
        return;
      }
      liveTerminal.current = reply.terminalId;
      setTerminal(reply.terminalId);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Couldn't open the CLI. Copy the prompt and try it in your terminal.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      {!previewing && (
        <>
          <div className="flex items-center justify-between gap-3 text-ui">
            <span>Prompt template</span>
            <Select<TriageKind>
              label="Prompt template"
              value={kind}
              options={triageTemplates}
              onValueChange={setKind}
              disabled={busy}
            />
          </div>
          <label className="block space-y-2 text-ui">
            <span>Description</span>
            <Textarea
              aria-label="Description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={16_000}
              disabled={busy}
              placeholder="What happened, what did you expect, and what should change?"
            />
          </label>
          <label className="flex items-center gap-2 text-ui">
            <Checkbox
              checked={include}
              onCheckedChange={(value) => setInclude(value === true)}
              disabled={busy}
            />
            Include diagnostics
          </label>
          <div className="flex justify-end">
            <Button
              disabled={busy || !description.trim() || (include && !props.report && !ready)}
              onClick={() => void generate()}
            >
              {busy ? "Generating…" : "Generate prompt"}
            </Button>
          </div>
        </>
      )}
      {previewing && (
        <>
          <label className="block space-y-2 text-ui">
            <span>Generated prompt</span>
            <Textarea
              aria-label="Generated prompt"
              className="min-h-48 font-mono text-sm"
              value={prompt}
              maxLength={48_000}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={busy || !!terminal}
            />
          </label>
          {!terminal && (
            <>
              <SegmentedControl<TriageProvider>
                label="Open in"
                value={provider}
                options={triageProviders}
                onValueChange={setProvider}
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" disabled={busy} onClick={() => setPreviewing(false)}>
                  Edit description
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => void copy.copy(prompt)}>
                  {copy.copied ? "Copied" : "Copy prompt"}
                </Button>
                <Button disabled={busy || !ready || !prompt.trim()} onClick={() => void launch()}>
                  {busy
                    ? "Opening…"
                    : `Open in ${triageProviders.find((entry) => entry.value === provider)?.label}`}
                </Button>
              </div>
            </>
          )}
          {terminal && (
            <>
              <Suspense
                fallback={<p className="text-ui text-muted-foreground">Opening the terminal…</p>}
              >
                <InteractiveTerminal
                  terminalId={terminal}
                  label="ace triage CLI"
                  onExit={setExit}
                />
              </Suspense>
              <div className="flex items-center justify-between gap-3 text-ui">
                <span className="text-muted-foreground">
                  {exit === undefined ? "CLI session open" : `CLI exited with code ${exit}`}
                </span>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void stop(terminal).then(() => {
                      liveTerminal.current = undefined;
                      setTerminal(undefined);
                    })
                  }
                >
                  {exit === undefined ? "Close CLI" : "Back to prompt"}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-ui text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
