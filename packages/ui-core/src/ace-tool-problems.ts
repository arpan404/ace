/*
 * Why one of ace's own tools failed, in a person's words with what to do next: "Safari didn't
 * accept that key in the background". The raw code stays with the step for its Details. Codes
 * are the screen helper's and ace's public MCP catalog's; one ace has no sentence for reads as
 * the catalog's message, else as "Couldn't …" what the step tried. Pure.
 */

export type AceToolFamily = "screen" | "browser" | "device" | "agents" | "threads" | "ace";

/** What kind of input a step sent, so a refusal can name it. */
export type InputKind = "key" | "type" | "paste" | "click" | "scroll" | "act" | "other";

export interface ToolProblem {
  /** One sentence: what went wrong, naming the app, site or device. */
  title: string;
  /** What the person (or the agent) can do about it. */
  hint?: string | undefined;
  /** The raw code, for Details only. */
  code: string;
}

export interface ProblemSituation {
  family: AceToolFamily;
  code: string;
  /** "Safari", "github.com", "iPhone 16"; undefined when not known. */
  subject?: string | undefined;
  input?: InputKind | undefined;
  mode?: "background" | "foreground" | undefined;
  /** What the step tried, imperative: "press ⌘L in Safari". */
  attempt: string;
  /** ace's catalog message for the code, when the tool answered with one. */
  message?: string | undefined;
}

type Words = { title: string; hint?: string };
type Wording = (subject: string, situation: ProblemSituation) => Words;

const refused: Record<InputKind, string> = {
  key: "that key",
  type: "typing",
  paste: "pasting",
  click: "that click",
  scroll: "scrolling",
  act: "that action",
  other: "that",
};
const during: Record<InputKind, string> = {
  key: "pressing a key",
  type: "typing",
  paste: "pasting",
  click: "clicking",
  scroll: "scrolling",
  act: "acting",
  other: "working",
};

const readAgain = (thing: string) => `The agent should read the ${thing} again before retrying.`;

const screen: Record<string, Wording> = {
  not_supported: (app, { input = "other", mode }) => ({
    title: `${app} didn't accept ${refused[input]}${mode === "background" ? " in the background" : ""}`,
    hint:
      mode === "background"
        ? `Some apps ignore input sent in the background. The agent can ask to bring ${app} to the front.`
        : "Try another way, such as the app's own buttons or menus.",
  }),
  focus_changed: (app, { input = "other" }) => ({
    title: `${possessive(app)} focus changed while ${during[input]}; try again`,
    hint: "Another window or the pointer moved during the action. ace puts focus back when you weren't using the Mac.",
  }),
  window_offscreen: (app) => ({
    title: `${possessive(app)} window is off-screen`,
    hint: "Move it onto a display, then try again.",
  }),
  window_minimized: (app) => ({
    title: `${possessive(app)} window is minimized`,
    hint: "Restore it, then try again.",
  }),
  bounds: (app) => ({
    title: `That point is outside ${possessive(app)} window`,
    hint: "The agent should take a fresh screenshot first.",
  }),
  foreground_required: (app) => ({
    title: `${app} needs to be in front for that`,
    hint: "The agent can ask to bring it to the front; you'll be asked to approve.",
  }),
  target_busy: (app) => ({
    title: `Another agent is using ${app}`,
    hint: "Take it over first, or wait for that agent to finish.",
  }),
  target_gone: (app) => ({ title: `${app} closed`, hint: "Open it again if you still need it." }),
  secure_input_required: (app) => ({
    title: `That's a password field in ${app}`,
    hint: "Allow secure input for this session, or type it yourself.",
  }),
  clipboard_changed: (app) => ({
    title: `The clipboard changed while pasting into ${app}`,
    hint: "Your new clipboard was kept. Try again.",
  }),
  permission_denied: (app) => ({
    title: `macOS hasn't let ace control ${app}`,
    hint: "Allow Screen Recording and Accessibility for Ace Screen Helper in System Settings.",
  }),
  approval_required: (app) => ({
    title: `${app} isn't approved yet`,
    hint: "Allow it when the agent asks.",
  }),
  denied: (app) => ({ title: `You didn't allow ${app}` }),
  screen_disabled: () => ({
    title: "Computer use is off",
    hint: "Turn it on in Settings › Computer use.",
  }),
  delegation_required: (app) => ({
    title: `${app} isn't handed to this agent`,
    hint: "Hand it to the agent from the Computer use panel.",
  }),
  screenshot_required: () => ({ title: "The agent needs a fresh screenshot first" }),
  screenshot_failed: (app) => ({ title: `Couldn't capture ${app}` }),
  timeout: (app) => ({
    title: `${app} didn't respond in time`,
    hint: "Nothing changed. Try again.",
  }),
  busy: (app) => ({ title: `${app} is busy with another action`, hint: "Wait for it to finish." }),
  stale_ref: (app) => ({
    title: `${possessive(app)} window changed before the action`,
    hint: readAgain("window"),
  }),
  read_only: () => ({
    title: "This thread is read-only",
    hint: "Its permission mode doesn't allow computer use.",
  }),
};

const browser: Record<string, Wording> = {
  human_controlled: () => ({
    title: "You have the browser",
    hint: "The agent waits until you hand it back.",
  }),
  human_private: () => ({
    title: "The browser is private while you have it",
    hint: "The agent waits until you hand it back.",
  }),
  browser_closed: () => ({ title: "The browser was closed", hint: "The agent can open it again." }),
  browser_paused: () => ({
    title: "The browser is paused",
    hint: "Restore it from the browser panel.",
  }),
  backend_changed: () => ({
    title: "The browser changed during the action",
    hint: readAgain("page"),
  }),
  controller_changed: () => ({ title: "Browser control changed", hint: readAgain("page") }),
  queue_full: () => ({ title: "The browser is busy", hint: "Wait for its actions to finish." }),
  stale_ref: () => ({ title: "The page changed before the action", hint: readAgain("page") }),
  element_unavailable: () => ({
    title: "That element is no longer on the page",
    hint: readAgain("page"),
  }),
  not_visible: () => ({ title: "That element isn't visible" }),
  evaluate_approval_required: (site) => ({
    title: `Scripts on ${site} need your approval`,
    hint: "Allow them when asked.",
  }),
  approval_required: (site) => ({
    title: `${site} needs your approval`,
    hint: "Allow the site when asked.",
  }),
  denied: (site) => ({ title: `You blocked ${site}` }),
  read_only: () => ({
    title: "This thread is read-only",
    hint: "Its permission mode doesn't allow browsing.",
  }),
  invalid_origin: () => ({
    title: "That address isn't one the agent can open",
    hint: "Only http and https addresses, without a password in them.",
  }),
  page_text_limit: () => ({ title: "The page is too large to search" }),
  timeout: (site) => ({ title: `${site} didn't respond in time` }),
};

const device: Record<string, Wording> = {
  not_booted: (name) => ({ title: `${name} isn't running`, hint: "The agent can boot it." }),
  sdk_missing: () => ({
    title: "Xcode or the Android SDK isn't set up",
    hint: "Install it on the Mac running ace.",
  }),
  tool_missing: () => ({
    title: "A device tool isn't installed",
    hint: "Install the capture and input tools on the Mac running ace.",
  }),
  not_found: (name) => ({
    title: `${name} wasn't found`,
    hint: "Check that it's still connected.",
  }),
  lease_required: (name) => ({
    title: `The agent no longer controls ${name}`,
    hint: "Hand it back to the agent from the Devices panel.",
  }),
  command_failed: (name) => ({ title: `${name} couldn't do that` }),
  limit: () => ({ title: "That's more than the device allows at once" }),
  permission_denied: (name) => ({
    title: `ace isn't allowed to use ${name}`,
    hint: "Check the device's approval and the Mac's permissions.",
  }),
  busy: (name) => ({ title: `${name} is busy`, hint: "Wait for its current action to finish." }),
  not_supported: (name) => ({ title: `${name} doesn't support that` }),
  stale_ref: (name) => ({
    title: `${possessive(name)} screen changed before the action`,
    hint: readAgain("screen"),
  }),
  timeout: (name) => ({ title: `${name} didn't respond in time` }),
};

const agents: Record<string, Wording> = {
  provider_unavailable: () => ({
    title: "That provider's CLI isn't available",
    hint: "Install it and sign in, or choose another provider.",
  }),
  provider_disabled: () => ({ title: "That provider is turned off" }),
  model_unavailable: () => ({ title: "That model isn't available" }),
  account_unavailable: () => ({ title: "That account isn't available" }),
  admission_closed: () => ({
    title: "ace isn't taking new work right now",
    hint: "Try again once it has started.",
  }),
  delegation_cancelled: () => ({ title: "The delegation was stopped" }),
  delegation_limit: () => ({
    title: "Too many agents are already working",
    hint: "Wait for some to finish.",
  }),
  delegation_denied: () => ({ title: "The new agent would have more access than this thread" }),
  workspace_unavailable: () => ({ title: "The project isn't available" }),
};

const shared: Record<string, Wording> = {
  invalid_arguments: () => ({ title: "The agent's request was malformed" }),
  invalid_data: () => ({ title: "The tool answered with something unexpected" }),
  timeout: () => ({ title: "No answer in time", hint: "Nothing changed. Try again." }),
};

const tables: Record<AceToolFamily, Record<string, Wording>> = {
  screen,
  browser,
  device,
  agents,
  threads: agents,
  ace: agents,
};

const defaultSubject: Record<AceToolFamily, string> = {
  screen: "the app",
  browser: "the page",
  device: "the device",
  agents: "ace",
  threads: "ace",
  ace: "ace",
};

function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/** A sentence starting with its subject: "the app" opens one with a capital. */
function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A failed step in words: what went wrong and what to do next. */
export function toolProblem(situation: ProblemSituation): ToolProblem {
  const subject = situation.subject ?? defaultSubject[situation.family];
  const wording = tables[situation.family][situation.code] ?? shared[situation.code];
  if (wording) {
    const { title, hint } = wording(subject, situation);
    return { title: capital(title), hint, code: situation.code };
  }
  // The catalog's generic failure says less than what the step tried.
  const generic = situation.code === "execution_failed";
  return {
    title: (!generic && situation.message) || `Couldn't ${situation.attempt}`,
    code: situation.code,
  };
}
