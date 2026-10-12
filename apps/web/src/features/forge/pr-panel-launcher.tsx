import { useState } from "react";
import { prFromUrl } from "@ace/forge/pr-reference";
import { Input } from "@/components/ui/input.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { PrPanelData, prPanelId } from "./pr-panel-data.ts";

export default function PrPanelLauncher(props: TabViewProps) {
  const actions = useWorkspaceActions(props.scope);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        try {
          const identity = PrPanelData.parse(props.tab.data);
          const parsed = address.trim().startsWith("https://")
            ? prFromUrl(address.trim())
            : undefined;
          const number = parsed?.number ?? Number(address.trim().replace(/^#/, ""));
          const data = PrPanelData.parse({
            workspaceId: identity.workspaceId,
            number,
            repository: parsed?.repository ?? identity.repository,
          });
          actions.replace(props.tab.key, {
            kind: "pull-request",
            id: prPanelId(data),
            title: `#${number}`,
            data,
          });
        } catch {
          setError(
            "Enter a GitHub PR URL or a positive PR number. Choose a project in the list first.",
          );
        }
      }}
    >
      <h2 className="text-ui font-medium">Open a pull request</h2>
      <Input
        autoFocus
        aria-label="New tab PR URL or number"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="GitHub PR URL or #number"
      />
      <Button type="submit" disabled={!address.trim()}>
        Open PR
      </Button>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
    </form>
  );
}
