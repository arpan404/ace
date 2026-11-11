import {
  spadeFormatNames,
  spadeFormats,
  type SpadeFormat,
  type SpadePreset,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { addEndpoint } from "./spade-api.ts";
import { modelsKey } from "./use-spade-models.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/** `Name: value` lines as headers; a line without a colon is left out. */
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    const name = line.slice(0, at).trim();
    if (at > 0 && name) headers[name] = line.slice(at + 1).trim();
  }
  return headers;
}

function Field(props: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.htmlFor} className="w-fit text-ui font-medium">
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

const custom = "custom";
const formatOptions = spadeFormats.map((value): SelectOption<SpadeFormat> => ({
  value,
  label: spadeFormatNames[value],
}));

/**
 * Add endpoint: from one of Spade's presets (its address, format and session header filled in)
 * or custom: name, format, base URL, extra headers and a session header. The key is set on the
 * endpoint's row once it is added, never here.
 */
export function AddEndpointDialog(props: { presets: readonly SpadePreset[]; onClose(): void }) {
  const ids = {
    from: useId(),
    name: useId(),
    format: useId(),
    url: useId(),
    headers: useId(),
    session: useId(),
  };
  const client = useSpadeClient();
  const cache = useQueryClient();
  const [from, setFrom] = useState(custom);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<SpadeFormat>("openai-chat");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [session, setSession] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const choose = (next: string) => {
    setFrom(next);
    const preset = props.presets.find((candidate) => candidate.id === next);
    if (!preset) return;
    setName(preset.name);
    if (preset.format) setFormat(preset.format);
    setUrl(preset.baseUrl);
    setSession(preset.sessionHeader ?? "");
  };
  const ready = name.trim() !== "" && /^https?:\/\/\S+$/.test(url.trim());
  const add = async () => {
    setSaving(true);
    setProblem(undefined);
    const extra = parseHeaderLines(headers);
    try {
      await addEndpoint(client, {
        name: name.trim(),
        format,
        base_url: url.trim(),
        ...(Object.keys(extra).length ? { headers: extra } : {}),
        ...(session.trim() ? { session_header: session.trim() } : {}),
        ...(from === custom ? {} : { preset: from }),
      });
      await cache.invalidateQueries({ queryKey: modelsKey });
      props.onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add endpoint</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Field label="From" htmlFor={ids.from}>
            <Select
              id={ids.from}
              label="From"
              value={from}
              options={[
                { value: custom, label: "Custom" },
                ...props.presets.map((preset) => ({ value: preset.id, label: preset.name })),
              ]}
              onValueChange={choose}
              className="w-full"
            />
          </Field>
          <Field label="Name" htmlFor={ids.name}>
            <Input id={ids.name} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Format" htmlFor={ids.format}>
            <Select<SpadeFormat>
              id={ids.format}
              label="Format"
              value={format}
              options={formatOptions}
              onValueChange={setFormat}
              className="w-full"
            />
          </Field>
          <Field label="Base URL" htmlFor={ids.url}>
            <Input
              id={ids.url}
              placeholder="https://api.example.com/v1/"
              spellCheck={false}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
          <Field label="Headers" htmlFor={ids.headers}>
            <Textarea
              id={ids.headers}
              placeholder="Name: value, one a line"
              spellCheck={false}
              value={headers}
              onChange={(event) => setHeaders(event.target.value)}
              className="min-h-14 font-mono"
            />
          </Field>
          <Field label="Session header" htmlFor={ids.session}>
            <Input
              id={ids.session}
              placeholder="None"
              spellCheck={false}
              value={session}
              onChange={(event) => setSession(event.target.value)}
            />
          </Field>
          {problem && (
            <p role="alert" className="text-ui text-destructive">
              {problem}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || saving} onClick={() => void add()}>
            {saving ? "Adding…" : "Add endpoint"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
