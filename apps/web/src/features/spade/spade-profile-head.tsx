import { botFaceStateOf, faceForId } from "@ace/ui-core/bot-face";
import { spadeAgentNameMax } from "@ace/ui-core/spade-chat";
import { useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { AvatarChoice, draftFace, type AvatarDraft } from "./spade-avatar-choice.tsx";
import { DottedFace, faceDotOf } from "./spade-list-parts.tsx";
import { spadeBotRow } from "./spade-list-rows.ts";
import { sentAvatar, useEditBot } from "./spade-profile-actions.ts";
import { useWornPairs, type RosterBot } from "./use-spade-roster.ts";

/** `--spade-profile-face`. */
const faceSize = 96;

/**
 * The profile's head: the bot's 96px face (its dot ringed at 14px) and its name in 22/28, both
 * edited where they are. The face opens a popover to change it, saved as the popover closes;
 * the name turns into its field, ↵ or leaving it saves, Esc puts it back. Spade keeps its own
 * face and name.
 */
export function ProfileHead(props: { bot: RosterBot }) {
  const { bot } = props;
  const main = bot.kind === "main";
  const state = bot.away || bot.unavailable ? "idle" : botFaceStateOf(bot);
  const face = (
    <DottedFace
      avatar={bot.avatar}
      size={faceSize}
      state={state}
      dot={faceDotOf(spadeBotRow(bot).state)}
      large
    />
  );
  return (
    <div
      {...part("page-header", undefined, "profile")}
      className="flex flex-col items-center gap-2.5 px-4 pt-5 pb-4 text-center [--row-wash:var(--panel)]"
    >
      {main ? face : <FaceButton bot={bot}>{face}</FaceButton>}
      {main ? (
        <h2
          {...part("page-title")}
          className="max-w-full truncate px-2 text-2xl font-semibold tracking-title text-foreground"
        >
          {bot.name}
        </h2>
      ) : (
        <NameField bot={bot} />
      )}
      {bot.fullAccess && <p className="-mt-1.5 text-ui text-muted-foreground">Full access</p>}
    </div>
  );
}

/** The face as a button: a popover of faces and pictures; what the person chose saves on close. */
export function FaceButton(props: {
  bot: RosterBot;
  children: React.ReactNode;
  /** Its accessible name; "Change face" when absent. */
  label?: string;
}) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const worn = useWornPairs(bot.id);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AvatarDraft>({ kind: "current", avatar: bot.avatar });
  const [problem, setProblem] = useState<string>();
  const close = () => {
    const avatar = sentAvatar(draft);
    const same =
      draft.kind === "face" &&
      bot.avatar.kind === "character" &&
      JSON.stringify(draft.face) === JSON.stringify(bot.avatar.face);
    if (!avatar || same) return;
    void edit({ avatar }).then((refused) => {
      setProblem(refused);
      if (!refused) setDraft({ kind: "current", avatar: bot.avatar });
    });
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setProblem(undefined);
          setDraft({ kind: "current", avatar: bot.avatar });
        } else close();
      }}
    >
      <PopoverTrigger
        aria-label={props.label ?? "Change face"}
        className="relative rounded-full focus-ring before:absolute before:-inset-1.5 before:-z-1 before:rounded-full before:transition-colors before:duration-(--motion-fast) hover:before:bg-hover aria-expanded:before:bg-active"
      >
        {props.children}
      </PopoverTrigger>
      <PopoverContent align="center" className="w-80 p-3">
        <AvatarChoice
          value={draft}
          fallback={draftFace(draft) ?? faceForId(bot.id)}
          takenPairs={worn}
          onChange={setDraft}
        />
      </PopoverContent>
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {`Couldn't change the face. ${problem}`}
        </p>
      )}
    </Popover>
  );
}

/** The name, edited in place: its button turns into the field at the same size. */
function NameField(props: { bot: RosterBot }) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(bot.name);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  // Esc put it back: the blur as the field goes must not save what was dropped.
  const dropped = useRef(false);
  const save = async () => {
    if (dropped.current) return;
    const name = text.trim();
    if (!name || name === bot.name) {
      setText(bot.name);
      setEditing(false);
      return;
    }
    setSaving(true);
    const refused = await edit({ name });
    setSaving(false);
    setProblem(refused);
    if (!refused) setEditing(false);
  };
  const type = "text-2xl font-semibold tracking-title text-foreground";
  if (!editing)
    return (
      <button
        type="button"
        aria-label={`Rename ${bot.name}`}
        {...part("page-title")}
        onClick={() => {
          dropped.current = false;
          setText(bot.name);
          setProblem(undefined);
          setEditing(true);
        }}
        className={cn(
          "max-w-full truncate rounded-md px-2 transition-colors duration-(--motion-fast) focus-ring hover:bg-hover",
          type,
        )}
      >
        {bot.name}
      </button>
    );
  return (
    <div className="flex w-full flex-col items-center gap-1">
      <input
        aria-label="Name"
        value={text}
        autoFocus
        maxLength={spadeAgentNameMax}
        disabled={saving}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => setText(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            dropped.current = true;
            setText(bot.name);
            setProblem(undefined);
            setEditing(false);
          }
        }}
        className={cn(
          "h-7 w-full max-w-72 rounded-md bg-chat-well px-2 text-center shadow-[inset_0_0_0_1px_var(--foreground)] outline-none",
          type,
        )}
      />
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
