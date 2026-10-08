import { useId, useState } from "react";
import type { ProviderKind } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Select } from "@/components/ui/select.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";
import type { ProviderMcpSource } from "./provider-mcp-source.ts";

export default function AddMcpServer(props: {
  source: ProviderMcpSource;
  provider?: ProviderKind | undefined;
  onClose(): void;
  onAdded(): Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState("command");
  const [address, setAddress] = useState("");
  const [args, setArgs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add MCP server</DialogTitle>
          <DialogDescription>
            {props.provider === "opencode"
              ? "Added to this OpenCode session."
              : "Saved in your coding agent’s own configuration."}{" "}
            Set environment variables and authentication headers there. Keep secrets out of these
            fields.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            void props.source
              .add(
                name.trim(),
                transport === "http"
                  ? { transport: "http", url: address.trim() }
                  : {
                      transport: "command",
                      command: address.trim(),
                      args: args.split("\n").filter((arg) => arg.length > 0),
                    },
              )
              .then(async () => {
                await props.onAdded();
                props.onClose();
              })
              .catch(() => {
                setError(
                  "Could not add the server. Use a unique name and check the command or URL, then try again.",
                );
              })
              .finally(() => setBusy(false));
          }}
        >
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            required
            pattern="[A-Za-z0-9_-]{1,64}"
            maxLength={64}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Select
            label="Connection"
            value={transport}
            options={[
              { value: "command", label: "Command" },
              { value: "http", label: "URL" },
            ]}
            onValueChange={setTransport}
          />
          <Label htmlFor={`${id}-address`}>{transport === "http" ? "Server URL" : "Command"}</Label>
          <Input
            id={`${id}-address`}
            required
            type={transport === "http" ? "url" : "text"}
            maxLength={2048}
            placeholder={transport === "http" ? "https://example.com/mcp" : "npx"}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          {transport === "command" && (
            <>
              <Label htmlFor={`${id}-args`}>Arguments (one per line)</Label>
              <Textarea id={`${id}-args`} value={args} onChange={(e) => setArgs(e.target.value)} />
            </>
          )}
          {error && (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim() === "ace"}>
              {busy ? "Adding…" : "Add server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
