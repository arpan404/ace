import { Kbd } from "@/components/ui/kbd.tsx";

const keys = [
  { keys: ["j", "k"], words: "move" },
  { keys: ["↵"], words: "open" },
  { keys: ["e"], words: "done" },
  { keys: ["m"], words: "mute" },
] as const;

/** The inbox's triage keys, in one quiet line at its foot. */
export function TriageKeys() {
  return (
    <p
      aria-label="Keyboard"
      className="flex flex-wrap gap-x-4 gap-y-1 py-1.5 text-xs text-subtle-foreground"
    >
      {keys.map((key) => (
        <span key={key.words} className="inline-flex items-center gap-1">
          {key.keys.map((letter) => (
            <Kbd key={letter} resolve={false}>
              {letter}
            </Kbd>
          ))}
          {key.words}
        </span>
      ))}
    </p>
  );
}
