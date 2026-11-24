import { serviceInfo } from "@ace/ui-core";
import {
  spadeFormatNames,
  spadeFormats,
  spadeLocalServerWords,
  type SpadeFormat,
  type SpadeLocalServer,
  type SpadePreset,
} from "@ace/ui-core/spade-chat";
import { CaretRightIcon, MagnifyingGlassIcon } from "@ace/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { BrandMark } from "@/components/ui/provider-icons.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { cn } from "@/lib/cn.ts";
import { addEndpoint } from "./spade-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import {
  buildAzureUrl,
  buildCloudflareUrl,
  buildVertexUrl,
  gcpRegions,
  mergeProviderTemplates,
  type CloudProviderKind,
  type SpadeProviderTemplate,
} from "./spade-provider-catalog.ts";
import { modelsKey, useLocalServers } from "./use-spade-models.ts";

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

function Field(props: {
  label: string;
  htmlFor: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.htmlFor} className="w-fit text-ui font-medium text-foreground">
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <p id={`${props.htmlFor}-error`} className="text-xs text-destructive">
          {props.error}
        </p>
      ) : (
        props.hint && <p className="text-xs text-subtle-foreground">{props.hint}</p>
      )}
    </div>
  );
}

const custom = "custom";
const formatOptions = spadeFormats.map((value): SelectOption<SpadeFormat> => ({
  value,
  label: spadeFormatNames[value],
}));
// Vertex's OpenAI-compatible endpoint speaks Chat Completions only; its Anthropic endpoint
// answers on a different path (`:streamRawPredict`) than Spade's adapter calls.
const vertexFormatOptions = formatOptions.filter((option) => option.value === "openai-chat");

const azureResourcePattern = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/i;
const gcpProjectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const gcpRegionPattern = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const cloudflareAccountPattern = /^[a-f0-9]{32}$/i;
const cloudflareGatewayPattern = /^[a-z0-9_-]+$/i;

/** Why an identifier isn't usable yet, or undefined when it is. */
function identifierProblem(value: string, empty: string, pattern: RegExp, invalid: string) {
  const clean = value.trim();
  if (!clean) return empty;
  return pattern.test(clean) ? undefined : invalid;
}

/**
 * Add a provider: quick-pick from Spade's presets, cloud providers (Google Vertex AI on GCP,
 * Azure OpenAI, Cloudflare AI Gateway), popular inference providers (OpenRouter, Groq, Together,
 * Fireworks, DeepSeek, xAI, Mistral, Cerebras), local servers, or a custom endpoint.
 */
export function AddEndpointDialog(props: { presets: readonly SpadePreset[]; onClose(): void }) {
  const ids = {
    from: useId(),
    name: useId(),
    format: useId(),
    url: useId(),
    headers: useId(),
    session: useId(),
    key: useId(),
    gcpProject: useId(),
    gcpRegion: useId(),
    gcpCustomRegion: useId(),
    azureResource: useId(),
    cfAccount: useId(),
    cfGateway: useId(),
  };
  const client = useSpadeClient();
  const cache = useQueryClient();
  const templates = useMemo(() => mergeProviderTemplates(props.presets), [props.presets]);
  const [from, setFrom] = useState(custom);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [format, setFormat] = useState<SpadeFormat>("openai-chat");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [session, setSession] = useState("");
  const [needsKey, setNeedsKey] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Cloud endpoint helpers
  const [gcpProject, setGcpProject] = useState("");
  const [gcpRegion, setGcpRegion] = useState("global");
  const [gcpCustomRegion, setGcpCustomRegion] = useState("");
  const [azureResource, setAzureResource] = useState("");
  const [cfAccount, setCfAccount] = useState("");
  const [cfGateway, setCfGateway] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const locals = useLocalServers(true).data ?? [];

  const activeTemplate = templates.find((candidate) => candidate.id === from);
  const activeCloud: CloudProviderKind | undefined = activeTemplate?.cloud;

  const choose = (next: string) => {
    const local = locals.find((candidate) => localChoice(candidate) === next);
    if (local) return fillLocal(local);
    setFrom(next);
    if (next === custom) return;
    const template = templates.find((candidate) => candidate.id === next);
    if (!template) return;
    setName(template.name);
    setFormat(template.cloud === "vertex" ? "openai-chat" : template.format);
    setNeedsKey(true);
    setSession(template.sessionHeader ?? "");
    if (template.sessionHeader) setShowAdvanced(true);
    if (template.cloud === "vertex") {
      const region = gcpRegion === "custom" ? gcpCustomRegion : gcpRegion;
      setUrl(buildVertexUrl(gcpProject, region));
    } else if (template.cloud === "azure") {
      setUrl(buildAzureUrl(azureResource));
    } else if (template.cloud === "cloudflare") {
      setUrl(buildCloudflareUrl(cfAccount, cfGateway));
    } else {
      setUrl(template.baseUrl);
    }
  };

  const fillLocal = (local: SpadeLocalServer) => {
    setFrom(localChoice(local));
    setName(local.name);
    setFormat("openai-chat");
    setUrl(local.baseUrl);
    setSession("");
    setNeedsKey(false);
  };

  const updateFormat = (next: SpadeFormat) => {
    setFormat(next);
    if (activeCloud === "vertex") {
      const region = gcpRegion === "custom" ? gcpCustomRegion : gcpRegion;
      setUrl(buildVertexUrl(gcpProject, region));
    }
  };

  const updateVertex = (project: string, regionChoice: string, customReg: string) => {
    setGcpProject(project);
    setGcpRegion(regionChoice);
    setGcpCustomRegion(customReg);
    const resolved = regionChoice === "custom" ? customReg : regionChoice;
    setUrl(buildVertexUrl(project, resolved));
  };

  const updateAzure = (resource: string) => {
    setAzureResource(resource);
    setUrl(buildAzureUrl(resource));
  };

  const updateCloudflare = (accountId: string, gateway: string) => {
    setCfAccount(accountId);
    setCfGateway(gateway);
    setUrl(buildCloudflareUrl(accountId, gateway));
  };

  const query = search.trim().toLowerCase();
  const visibleTemplates = query
    ? templates.filter((item) =>
        `${item.name} ${item.description} ${item.id}`.toLowerCase().includes(query),
      )
    : templates;

  const gcpProjectProblem =
    activeCloud === "vertex"
      ? identifierProblem(
          gcpProject,
          "Enter your GCP project ID.",
          gcpProjectPattern,
          "Use 6–30 lowercase letters, digits and hyphens, starting with a letter.",
        )
      : undefined;
  const gcpCustomRegionProblem =
    activeCloud === "vertex" && gcpRegion === "custom"
      ? identifierProblem(
          gcpCustomRegion,
          "Enter the region.",
          gcpRegionPattern,
          "Use a region id such as europe-west3.",
        )
      : undefined;
  const azureResourceProblem =
    activeCloud === "azure"
      ? identifierProblem(
          azureResource,
          "Enter your Azure resource name.",
          azureResourcePattern,
          "Use letters, digits and hyphens.",
        )
      : undefined;
  const cfAccountProblem =
    activeCloud === "cloudflare"
      ? identifierProblem(
          cfAccount,
          "Enter your Cloudflare account ID.",
          cloudflareAccountPattern,
          "Use the 32-character account ID.",
        )
      : undefined;
  const cfGatewayProblem =
    activeCloud === "cloudflare"
      ? identifierProblem(
          cfGateway,
          "Enter your gateway name.",
          cloudflareGatewayPattern,
          "Use letters, digits, hyphens or underscores.",
        )
      : undefined;
  const identifiersReady = !(
    gcpProjectProblem ||
    gcpCustomRegionProblem ||
    azureResourceProblem ||
    cfAccountProblem ||
    cfGatewayProblem
  );
  const urlReady = /^https?:\/\/\S+$/.test(url.trim());
  const ready = name.trim() !== "" && urlReady && identifiersReady;
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
        ...(needsKey ? {} : { needs_key: false }),
        ...(props.presets.some((preset) => preset.id === from) ? { preset: from } : {}),
      });
      await cache.invalidateQueries({ queryKey: modelsKey });
      props.onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Try again.");
    } finally {
      setSaving(false);
    }
  };

  const selectOptions: SelectOption<string>[] = [
    { value: custom, label: "Custom" },
    ...templates.map((item) => ({ value: item.id, label: item.name })),
    ...locals.map((local) => ({
      value: localChoice(local),
      label: `${local.name} (on this computer)`,
    })),
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add a provider</DialogTitle>
          <DialogDescription>
            Connect a cloud region, inference provider, local model server, or custom endpoint.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-4">
          <LocalServers servers={locals} onUse={fillLocal} />

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={ids.from} className="text-ui font-medium text-foreground">
                From
              </label>
              <div className="w-52">
                <Select
                  id={ids.from}
                  label="From"
                  value={from}
                  options={selectOptions}
                  onValueChange={choose}
                  className="w-full"
                />
              </div>
            </div>
            <label className="flex h-8 min-w-0 items-center gap-1.5 rounded-md bg-secondary/40 px-2.5 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border-soft)] has-focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ring)_50%,transparent)]">
              <MagnifyingGlassIcon aria-hidden size={13} className="shrink-0" />
              <input
                type="search"
                value={search}
                aria-label="Filter providers"
                placeholder="Search GCP Vertex AI, OpenRouter, Groq, Azure…"
                onChange={(event) => setSearch(event.currentTarget.value)}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-subtle-foreground focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
            </label>
            <div className="grid max-h-36 grid-cols-2 gap-1.5 overflow-y-auto p-0.5 sm:grid-cols-3">
              {visibleTemplates.map((template) => (
                <ProviderTileButton
                  key={template.id}
                  template={template}
                  selected={from === template.id}
                  onPick={() => choose(template.id)}
                />
              ))}
              {!query && (
                <button
                  type="button"
                  onClick={() => choose(custom)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors duration-(--motion-fast) focus-ring-inset",
                    from === custom
                      ? "border-foreground/75 bg-accent/50 ring-1 ring-inset ring-foreground/75"
                      : "border-border-soft hover:border-border hover:bg-accent/25",
                  )}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-xs font-medium text-foreground">Custom</span>
                    <span className="truncate text-[11px] text-subtle-foreground">
                      Any compatible URL
                    </span>
                  </span>
                </button>
              )}
            </div>
          </div>

          {activeCloud === "vertex" && (
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-border-soft bg-secondary/35 p-3 sm:grid-cols-2">
              <Field label="GCP project ID" htmlFor={ids.gcpProject} error={gcpProjectProblem}>
                <Input
                  id={ids.gcpProject}
                  placeholder="my-gcp-project"
                  spellCheck={false}
                  value={gcpProject}
                  aria-invalid={gcpProjectProblem ? true : undefined}
                  aria-describedby={gcpProjectProblem ? `${ids.gcpProject}-error` : undefined}
                  onChange={(event) => updateVertex(event.target.value, gcpRegion, gcpCustomRegion)}
                />
              </Field>
              <Field label="Region" htmlFor={ids.gcpRegion}>
                <Select
                  id={ids.gcpRegion}
                  label="Region"
                  value={gcpRegion}
                  options={gcpRegions}
                  onValueChange={(next) => updateVertex(gcpProject, next, gcpCustomRegion)}
                  className="w-full"
                />
              </Field>
              {gcpRegion === "custom" && (
                <div className="sm:col-span-2">
                  <Field
                    label="Custom region"
                    htmlFor={ids.gcpCustomRegion}
                    error={gcpCustomRegionProblem}
                  >
                    <Input
                      id={ids.gcpCustomRegion}
                      placeholder="europe-west3"
                      spellCheck={false}
                      value={gcpCustomRegion}
                      aria-invalid={gcpCustomRegionProblem ? true : undefined}
                      aria-describedby={
                        gcpCustomRegionProblem ? `${ids.gcpCustomRegion}-error` : undefined
                      }
                      onChange={(event) => updateVertex(gcpProject, "custom", event.target.value)}
                    />
                  </Field>
                </div>
              )}
            </div>
          )}

          {activeCloud === "azure" && (
            <Field
              label="Azure resource name"
              htmlFor={ids.azureResource}
              error={azureResourceProblem}
            >
              <Input
                id={ids.azureResource}
                placeholder="my-openai-resource"
                spellCheck={false}
                value={azureResource}
                aria-invalid={azureResourceProblem ? true : undefined}
                aria-describedby={
                  azureResourceProblem ? `${ids.azureResource}-error` : undefined
                }
                onChange={(event) => updateAzure(event.target.value)}
              />
            </Field>
          )}

          {activeCloud === "cloudflare" && (
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-border-soft bg-secondary/35 p-3 sm:grid-cols-2">
              <Field label="Account ID" htmlFor={ids.cfAccount} error={cfAccountProblem}>
                <Input
                  id={ids.cfAccount}
                  placeholder="32-char account id"
                  spellCheck={false}
                  value={cfAccount}
                  aria-invalid={cfAccountProblem ? true : undefined}
                  aria-describedby={cfAccountProblem ? `${ids.cfAccount}-error` : undefined}
                  onChange={(event) => updateCloudflare(event.target.value, cfGateway)}
                />
              </Field>
              <Field label="Gateway name" htmlFor={ids.cfGateway} error={cfGatewayProblem}>
                <Input
                  id={ids.cfGateway}
                  placeholder="my-gateway"
                  spellCheck={false}
                  value={cfGateway}
                  aria-invalid={cfGatewayProblem ? true : undefined}
                  aria-describedby={cfGatewayProblem ? `${ids.cfGateway}-error` : undefined}
                  onChange={(event) => updateCloudflare(cfAccount, event.target.value)}
                />
              </Field>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor={ids.name}>
              <Input
                id={ids.name}
                placeholder="OpenRouter"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Format" htmlFor={ids.format}>
              <Select<SpadeFormat>
                id={ids.format}
                label="Format"
                value={format}
                options={activeCloud === "vertex" ? vertexFormatOptions : formatOptions}
                onValueChange={updateFormat}
                className="w-full"
              />
            </Field>
          </div>

          <Field
            label="Base URL"
            htmlFor={ids.url}
            hint={
              activeCloud === "vertex"
                ? "Auto-built from your GCP project and region. Direct Vertex access needs a Google Cloud access token as the key."
                : undefined
            }
          >
            <Input
              id={ids.url}
              placeholder="https://api.example.com/v1/"
              spellCheck={false}
              className="font-mono text-xs"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border-soft px-3 py-2.5">
            <div className="flex flex-col gap-0.5">
              <label htmlFor={ids.key} className="text-ui font-medium text-foreground">
                Needs a key
              </label>
              <span className="text-xs text-muted-foreground">
                Turn off for local model servers or keyless gateways.
              </span>
            </div>
            <Switch id={ids.key} checked={needsKey} onCheckedChange={setNeedsKey} />
          </div>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setShowAdvanced((open) => !open)}
              className="flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-ring"
            >
              <CaretRightIcon
                aria-hidden
                size={12}
                className={cn(
                  "transition-transform duration-(--motion-fast)",
                  showAdvanced && "rotate-90",
                )}
              />
              Advanced options (headers, session header)
            </button>
            {showAdvanced && (
              <div className="flex flex-col gap-3">
                <Field label="Headers" htmlFor={ids.headers}>
                  <Textarea
                    id={ids.headers}
                    placeholder="Name: value, one a line"
                    spellCheck={false}
                    value={headers}
                    onChange={(event) => setHeaders(event.target.value)}
                    className="min-h-14 font-mono text-xs"
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
              </div>
            )}
          </div>

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
            {saving ? "Adding…" : "Add provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderTileButton(props: {
  template: SpadeProviderTemplate;
  selected: boolean;
  onPick(): void;
}) {
  const { template } = props;
  const brand = serviceInfo(template.brandId).brand;
  return (
    <button
      type="button"
      onClick={props.onPick}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors duration-(--motion-fast) focus-ring-inset",
        props.selected
          ? "border-foreground/75 bg-accent/50 ring-1 ring-inset ring-foreground/75"
          : "border-border-soft hover:border-border hover:bg-accent/25",
      )}
    >
      <BrandMark
        size={16}
        decorative
        className="shrink-0"
        choose={() => ({ brand, label: template.name })}
        fallbackLabel={template.name}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-medium text-foreground">{template.name}</span>
        <span className="truncate text-[11px] text-subtle-foreground">{template.description}</span>
      </span>
    </button>
  );
}

/** A local server's value in the From list, apart from the presets' ids. */
const localChoice = (local: SpadeLocalServer) => `local:${local.id}`;

/**
 * Model servers on this computer (Ollama, LM Studio), looked for at their usual ports: each one
 * running offers Use, which fills in its address with no key. Nothing found, nothing shown.
 */
function LocalServers(props: {
  servers: readonly SpadeLocalServer[];
  onUse(local: SpadeLocalServer): void;
}) {
  const headingId = useId();
  const servers = props.servers;
  if (!servers.some((local) => local.running)) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1.5 rounded-lg border border-border-soft bg-secondary/35 p-3"
    >
      <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
        On this computer
      </h3>
      <ul className="flex flex-col divide-y divide-border-soft">
        {servers.map((local) => (
          <li
            key={local.id}
            className="flex min-h-9 items-center gap-2.5 py-1.5 first:pt-0 last:pb-0"
          >
            <BrandMark
              size={16}
              decorative
              className="shrink-0"
              choose={() => ({ brand: serviceInfo(local.id).brand, label: local.name })}
              fallbackLabel={local.name}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-ui font-medium text-foreground">{local.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {local.endpoint ? "Added already" : spadeLocalServerWords(local)}
              </span>
              {local.running && local.models.length > 0 && (
                <span className="truncate text-xs text-subtle-foreground">
                  {local.models.join(", ")}
                </span>
              )}
            </div>
            {local.running && !local.endpoint && (
              <Button variant="secondary" size="sm" onClick={() => props.onUse(local)}>
                Use
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
