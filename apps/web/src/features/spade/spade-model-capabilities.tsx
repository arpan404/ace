import {
  BrainIcon,
  GlobeIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  MicrophoneIcon,
  SpeakerHighIcon,
  WrenchIcon,
} from "@ace/icons";
import type { ComponentType } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";

interface CapabilityIcon {
  label: string;
  Icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
}

const capabilityIcons: Record<string, CapabilityIcon> = {
  images: { label: "Images", Icon: ImageIcon },
  vision: { label: "Images", Icon: ImageIcon },
  tools: { label: "Tools", Icon: WrenchIcon },
  reasoning: { label: "Reasoning", Icon: BrainIcon },
  "web-search": { label: "Web search", Icon: GlobeIcon },
  web_search: { label: "Web search", Icon: GlobeIcon },
  web: { label: "Web search", Icon: GlobeIcon },
  "native-tool-search": { label: "Tool search", Icon: MagnifyingGlassIcon },
  transcription: { label: "Transcription", Icon: MicrophoneIcon },
  audio: { label: "Transcription", Icon: MicrophoneIcon },
  speech: { label: "Speech", Icon: SpeakerHighIcon },
  tts: { label: "Speech", Icon: SpeakerHighIcon },
};

/**
 * A model's capabilities as compact icons with tooltips (Images, Tools, Reasoning, …).
 * Unknown capabilities still show quietly as text so nothing from a provider is dropped.
 */
export function SpadeModelCapabilities(props: { capabilities: readonly string[]; size?: number }) {
  if (!props.capabilities.length) return null;
  const size = props.size ?? 13;
  const seen = new Set<string>();
  const known: CapabilityIcon[] = [];
  const unknown: string[] = [];
  for (const raw of props.capabilities) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const match = capabilityIcons[key];
    if (match) {
      if (!seen.has(match.label)) {
        seen.add(match.label);
        known.push(match);
      }
    } else if (!seen.has(key)) {
      seen.add(key);
      unknown.push(raw);
    }
  }
  if (!known.length && !unknown.length) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {known.map(({ label, Icon }) => (
        <Tip key={label} label={label} side="top">
          <span
            role="img"
            aria-label={label}
            className="inline-flex items-center justify-center text-subtle-foreground transition-colors hover:text-foreground"
          >
            <Icon aria-hidden size={size} />
          </span>
        </Tip>
      ))}
      {unknown.length > 0 && (
        <span className="truncate text-xs text-subtle-foreground">{unknown.join(", ")}</span>
      )}
    </span>
  );
}
