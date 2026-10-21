/*
 * Why one of ace's own tools failed, in a person's words with what to do next: "Safari didn't
 * accept that key in the background". The raw code stays with the step for its Details. Codes
 * are the screen helper's and ace's public MCP catalog's, whose own message and hint are written
 * for the agent and never shown: a code ace has no sentence for reads as "Couldn't …" what the
 * step tried. Pure.
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
  /** A failure with no public code: the first line of what the tool said. */
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
    hint: "The agent can bring it to the front.",
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
  window_ambiguous: (app) => ({
    title: `${app} has more than one window like that`,
    hint: "The agent should pick one of its windows.",
  }),
  key_unsupported: () => ({ title: "That key isn't one ace can press" }),
  modifier_unsupported: () => ({ title: "That modifier key isn't one ace can press" }),
  no_key_window: (app) => ({
    title: `${app} has no field ready for typing`,
    hint: "The agent can pick a field first.",
  }),
  delivery_unconfirmed: (app) => ({
    title: `Couldn't confirm the input reached ${app}`,
    hint: `The agent should check ${app} before trying again.`,
  }),
};

const browser: Record<string, Wording> = {
  human_active: () => ({
    title: "You were using that tab",
    hint: "The agent tries again once you pause.",
  }),
  human_private: () => ({
    title: "You keep agents out of that tab",
    hint: "Let agents in from the tab's menu, or the agent uses another tab.",
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
  queue_full: () => ({ title: "The browser is busy", hint: "Wait for its actions to finish." }),
  stale_ref: () => ({ title: "The page changed before the action", hint: readAgain("page") }),
  element_unavailable: () => ({
    title: "That element is no longer on the page",
    hint: readAgain("page"),
  }),
  not_visible: () => ({ title: "That element isn't visible" }),
  evaluate_approval_required: (site) => ({ title: `Scripts on ${site} were refused` }),
  approval_required: (site) => ({ title: `The browser refused ${site}` }),
  denied: () => ({ title: "The browser refused the request" }),
  invalid_origin: () => ({
    title: "That address isn't one the agent can open",
    hint: "Only http and https addresses, without a password in them.",
  }),
  timeout: (site) => ({ title: `${site} didn't respond in time` }),
  page_unreachable: (site) => ({
    title: `Couldn't reach ${site}`,
    hint: "If it's a local dev server, check that it's running.",
  }),
  browser_restarted: () => ({
    title: "The browser restarted and reopened the page",
    hint: readAgain("page"),
  }),
  browser_unavailable: () => ({ title: "ace's browser couldn't start" }),
  evaluate_failed: () => ({ title: "The page script failed" }),
  recording_active: () => ({ title: "The browser is already recording" }),
  recording_inactive: () => ({ title: "The browser wasn't recording" }),
  recording_failed: () => ({ title: "The recording couldn't be saved" }),
  needs_person: (site) => ({
    title: `${site} needs you`,
    hint: "It shows a warning only you can get past, in the Browser panel.",
  }),
  tab_not_found: () => ({ title: "That tab is closed" }),
  tab_limit: () => ({
    title: "Too many tabs are open",
    hint: "Close the ones you no longer need.",
  }),
  tab_crashed: () => ({ title: "The page crashed", hint: "Reload it to bring it back." }),
  not_hittable: () => ({
    title: "That element couldn't take the click",
    hint: "It was out of view or kept moving.",
  }),
  covered: () => ({
    title: "Something covers that element",
    hint: "A banner, dialog or header sits over it.",
  }),
  viewport_mismatch: () => ({
    title: "The tab kept its own size",
    hint: "The Browser panel may be holding it at its size.",
  }),
  unsaved_changes: (site) => ({
    title: `You have unsaved changes on ${site}`,
    hint: "Leaving would discard them.",
  }),
  storage_restricted: () => ({
    title: "Agents can't read cookies or site storage in your Chrome",
    hint: "Allow it in Settings › Computer use › Use my Chrome.",
  }),
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
    title: `The agent doesn't control ${name}`,
    hint: "It can take the device again once nobody else is controlling it.",
  }),
  command_failed: (name) => ({ title: `${name} couldn't do that` }),
  limit: () => ({ title: "That's more than the device allows at once" }),
  permission_denied: (name) => ({
    title: `ace isn't allowed to use ${name}`,
    hint: "Check that devices are on and the Mac's permissions.",
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
  delegation_cancelled: () => ({ title: "This agent was stopped" }),
  delegation_limit: () => ({
    title: "The agent can't delegate any further",
    hint: "Agents nest only a few levels deep, and ace runs a bounded number at once.",
  }),
  delegation_denied: () => ({ title: "The new agent would have more access than this thread" }),
  access_escalation_denied: () => ({
    title: "The new agent would have more access than this thread",
  }),
  access_unavailable: () => ({ title: "That provider doesn't offer that access mode" }),
  effort_unavailable: () => ({ title: "That model doesn't offer that effort level" }),
  workspace_unavailable: () => ({ title: "The project isn't available" }),
  thread_not_found: () => ({ title: "That thread wasn't found" }),
  thread_busy: () => ({ title: "That thread is busy", hint: "Try again once it settles." }),
  request_conflict: () => ({ title: "That request was already sent with different details" }),
  handoff_unavailable: () => ({ title: "That thread can't be handed off right now" }),
};

/** Failures any of ace's tools can report, whichever family it is. */
const shared: Record<string, Wording> = {
  approval_timeout: () => ({
    title: "Site access wasn't approved in time",
    hint: "Allow the site in ace, then try again.",
  }),
  page_timeout: (site) => ({
    title: `${site} took too long to load`,
    hint: "Check the page and reload if needed.",
  }),
  tool_timeout: () => ({
    title: "The action took too long",
    hint: "Check its result before trying again.",
  }),
  cancelled: () => ({
    title: "The action was cancelled",
    hint: "It may have partly completed.",
  }),
  result_too_large: () => ({
    title: "The result is too large to show",
    hint: "The agent can request a smaller part.",
  }),
  calls_limit: () => ({
    title: "Too many actions are running at once",
    hint: "Wait for a running action to finish.",
  }),
  session_ended: () => ({
    title: "This session ended",
    hint: "Start a new turn to continue.",
  }),
  invalid_arguments: () => ({ title: "The agent's request was malformed" }),
  invalid_data: () => ({ title: "The tool answered with something unexpected" }),
  timeout: () => ({ title: "No answer in time", hint: "Nothing changed. Try again." }),
  invalid_html: () => ({ title: "That page has content ace can't show" }),
  invalid_image: () => ({ title: "That file isn't an image ace can show" }),
  image_unavailable: () => ({ title: "Couldn't read that image file" }),
  tool_unavailable: () => ({ title: "That ace tool isn't available in this thread" }),
  limit: () => ({ title: "That's more than ace takes at once" }),
  machine_offline: () => ({ title: "That machine is offline" }),
  machine_unavailable: () => ({ title: "That machine isn't available to agents" }),
  machine_forbidden: () => ({
    title: "Agents can't do that on that machine",
    hint: "Its agent access or pairing is read-only.",
  }),
  machine_disconnected: () => ({
    title: "Lost the connection to that machine",
    hint: "The action may or may not have run there.",
  }),
  user_browser_unavailable: () => ({
    title: "Your Chrome isn't connected to ace",
    hint: "Turn on Use my Chrome in Settings › Computer use and keep Chrome open.",
  }),
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
  // A code ace has no sentence for yet (a newer daemon's), or the catalog's generic failure,
  // reads as what the step tried: the catalog's own words are written for the agent. A failure
  // with no code at all reads as the tool's own first line.
  return {
    title: (situation.code === "failed" && situation.message) || `Couldn't ${situation.attempt}`,
    code: situation.code,
  };
}
