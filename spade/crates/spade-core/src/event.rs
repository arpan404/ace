//! A conversation's events, as stored. See docs/chat-core.md and docs/harness.md.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use spade_models::Thought;

use crate::tools::Risk;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Known {
    UserMessage {
        text: String,
        /// Per-turn context fixed when the message was stored (the time, matching memories), so
        /// rebuilding the prompt later gives the same bytes.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context: Option<String>,
        /// Images the person attached. The bytes live in Spade's image store, by hash.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        /// Documents the person attached (ADR 0134). Their bytes and text live in Spade's
        /// document store, by hash; each carries the view the prompt shows.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        documents: Vec<DocumentRef>,
        /// The recording, when the message was spoken; `text` is its transcript. Boxed to keep
        /// every event small.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        voice: Option<Box<VoiceRef>>,
        /// Another agent on this machine sent it (`bot_message`), not the person.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_agent: Option<FromAgent>,
        /// One of the agent's routines sent it (ADR 0129), not the person.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_routine: Option<Box<FromRoutine>>,
        /// It came through a group (ADR 0132): the bot's reply is posted there.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_group: Option<Box<FromGroup>>,
        /// The person wrote it in an ace thread (ADR 0198); `context`, when the thread's summary
        /// came with it, is untrusted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_thread: Option<Box<FromThread>>,
    },
    /// The agent's task or model changed (ADR 0126). Used from the next turn on: a turn's prompt
    /// takes the task in effect when its reply started, and `reply_started` names its model.
    AgentConfigured {
        task: String,
        model: String,
        /// How the bot talks, when the person (or its template or recipe) set it; its own section
        /// of the standing instructions. Absent on events from before personalities.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        personality: Option<crate::personality::Personality>,
        /// Who changed the task, from what and why, when this event changed it; missing on events
        /// from before task history and on a change of model alone. Boxed: most events carry none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        change: Option<Box<TaskChange>>,
    },
    /// This bot made a standing bot for the person (ADR 0161, amendment 1): its chat shows it with
    /// Open and Undo.
    BotMade {
        bot: String,
        name: String,
        task: String,
        /// The `bot_create` call's key: a run of the same call finds this bot.
        call: String,
    },
    /// This bot added a bot to a club it is a member of (ADR 0161, amendment 1).
    ClubAdded {
        club: String,
        club_name: String,
        bot: String,
        bot_name: String,
    },
    /// The bot was made from the person's first message without a name: its first turn chooses
    /// its name and face (`profile_update`) until it does, the person names it, or that reply
    /// ends (spade/docs/agents.md, New bots).
    NamingOpened {},
    /// The bot's name or face changed. `by` is `bot` (its own first naming, or with the person's
    /// OK) or `person`.
    ProfileChanged {
        name: String,
        by: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        face: bool,
    },
    /// The skill index for this conversation, stored before its first model call and again after
    /// each compaction, so the prompt's top stays cached in between; skills added meanwhile are
    /// found with `skill_search`. The latest one is in effect.
    SkillsIndexed {
        text: String,
    },
    /// The person's plugins for this conversation (ADR 0151): their rules, and what their
    /// `SessionStart` hooks added. Stored before the first model call, after each compaction and
    /// after the person changes the bot's plugins (`plugins_changed`); the latest one is in
    /// effect. `added` is a hook's text: untrusted.
    PluginsStarted {
        #[serde(default)]
        rules: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        added: String,
    },
    /// The person changed which plugins the bot may use. Its rules are stored again before the
    /// next model call.
    PluginsChanged {},
    /// A plugin's local server or hook can't be sealed off in this machine's sandbox (on Windows,
    /// one with network, or run from a folder Spade doesn't own), so it would run outside it:
    /// Spade asks the person before it starts, and it doesn't start until they allow it. `key`
    /// is what the answer is bound to: a digest of the bot, the plugin, its version and content
    /// hash, what runs (server or hook), its command and its environment.
    PluginOutsideAsked {
        id: String,
        plugin: String,
        version: String,
        /// The accepted install's content hash.
        hash: String,
        /// What would run: `server <name>` or `hook <event>`.
        what: String,
        /// The request's sentence.
        line: String,
        key: String,
    },
    /// The person's answer to a [`Known::PluginOutsideAsked`]: `always` keeps it for this plugin
    /// version (and the same command and environment); otherwise it covers one start.
    PluginOutsideAnswered {
        id: String,
        allowed: bool,
        #[serde(default)]
        always: bool,
    },
    /// What the person's plugin hooks answered at one of Spade's events (ADR 0151), stored once
    /// so a rebuilt prompt is the same and a restart never runs them again for it. `target` names
    /// what they answered: a call id, a message's or step's event index.
    HookRan {
        hook: String,
        target: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        outcomes: Vec<crate::hooks::HookOutcome>,
    },
    /// The bot's notes for the cached top of the prompt (ADR 0128), stored before the first model
    /// call and once after each compaction, so the top changes only when the conversation
    /// compacts.
    MemoryIndexed {
        text: String,
    },
    /// The topic index of the bot's knowledge base for the cached top (ADR 0164), stored before
    /// the first model call and once after each compaction, like `memory_indexed`.
    KnowledgeIndexed {
        text: String,
    },
    /// `ask_user`: the bot asked the person (ADR 0154). The turn waits for the answer unless a
    /// `question_deferred` follows. `question` is the prompts, one per line; `questions` holds
    /// each with its kind (absent on events stored before kinds: one `text` question).
    QuestionAsked {
        reply: String,
        call_id: String,
        question: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        questions: Vec<crate::question::Question>,
        /// Asked with `wait: false` (ADR 0154 decision 4): the bot keeps working, so the event's
        /// escalation level is `ask`, not `block` (ADR 0165). Its `question_deferred` follows.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        later: bool,
    },
    /// The question is left for later (ADR 0154): by the person (**Answer later**), or by the
    /// bot asking with `wait: false` (`by_bot`). The call is answered at once and the turn goes
    /// on; the question stays open until answered or dismissed.
    QuestionDeferred {
        call_id: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        by_bot: bool,
    },
    /// The person's answers, one per question, as checked. `late`: the question was deferred,
    /// so this reaches the bot like a job's result, as a `<question_answer>`. `typed`: a
    /// message the person typed (stored just before) stood for these answers; the bot reads the
    /// message itself.
    QuestionAnswered {
        call_id: String,
        answers: Vec<Value>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        late: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        typed: bool,
    },
    /// The person dismissed the question (**Never mind**). `late` as for `question_answered`.
    QuestionDismissed {
        call_id: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        late: bool,
    },
    /// One model call in a turn finished: its text, tool calls and the model's thoughts, kept
    /// whole so they go back exactly as they came.
    StepFinished {
        reply: String,
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        calls: Vec<Call>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        thoughts: Vec<Thought>,
        #[serde(default)]
        usage: Tokens,
        #[serde(default)]
        cost_micros: u64,
        /// How many of the conversation's events the step's prompt was built from. A message stored
        /// at or after this index arrived while the model was answering and is still unanswered.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seen: Option<usize>,
    },
    /// The gate stopped a tool call to ask the person.
    ApprovalRequested {
        reply: String,
        call_id: String,
        name: String,
        arguments: Value,
        /// What answering "always" covers, as the tool said when it asked (a terminal command's
        /// covers the command in the folder and with the variables it would run with, ADR
        /// 0142). Absent for older events and tools whose always covers the whole tool.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        /// Why the auto-review (ADR 0144) left this call to the person, in one line: the
        /// reviewer's reason, or the rule that always asks. Absent when the rule gate asked.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reviewer_reason: Option<String>,
        /// Why the person is asked when it isn't the usual request (ADR 0171): a tool that
        /// declares no effect, or a command the bot asks to run outside the sandbox. Absent for
        /// older events and the usual request; a word this build doesn't know reads as absent.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::effect::lenient_ask"
        )]
        ask: Option<crate::effect::Ask>,
        /// For a tool that declares nothing, what the person's answer is kept under: the bot,
        /// the tool's server and version, its own name and its schema (ADR 0171, amendment 1).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_key: Option<String>,
        /// For a driving step (`ask: drive`), the app or site its "always" allows for the bot
        /// (ADR 0171, amendment 3). Absent where it can't be allowed: a sensitive place, one
        /// Spade can't name, or any other request.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app: Option<String>,
        /// For a driving step, where Spade found it acts when it asked: the step runs only if
        /// it still acts there (ADR 0171, amendment 3).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acts_in: Option<Box<crate::effect::drive::Place>>,
        /// Set when a helper (ADR 0152) made the call: the approval is asked in the bot's
        /// conversation, the person answers it there, and the answer reaches the helper.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        helper: Option<Box<HelperAsk>>,
        /// Where the call was decided to run when the person was asked: the most their answer
        /// lets it run (ADR 0171, amendment 4). A call that would run anywhere wider at the
        /// launch doesn't run on it. Absent for older events and calls that run nothing.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "lenient_authorized"
        )]
        launch: Option<Authorized>,
        /// Set when one of Spade's judges stopped the call and it was put to the person instead
        /// of refused (ADR 0163, amendment 3): the reviewer, the second review, the classifier,
        /// or a check that couldn't vouch for what a command outside the sandbox runs. Absent
        /// for older events and every other request; a word this build doesn't know reads as
        /// absent.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::autonomy::escalate::lenient"
        )]
        stopped: Option<crate::autonomy::escalate::Stopped>,
    },
    ApprovalAnswered {
        reply: String,
        call_id: String,
        allowed: bool,
        /// Allow this tool without asking again in this conversation.
        #[serde(default)]
        always: bool,
    },
    ToolStarted {
        reply: String,
        call_id: String,
        name: String,
        /// The tool's risk when it was called, so compaction knows a write for what it was even
        /// after the tool is gone or reclassified. Missing on events from before it was recorded.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        risk: Option<Risk>,
        /// Whether it ran as a background job. Only meaningful when `risk` is recorded.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        background: bool,
        /// What the tool declared it does, as the gate read it (ADR 0171): the app shows a
        /// send, a payment, a publish or a change outside the bot as a step undo can't reach.
        /// Missing on events from before it was recorded and for undeclared tools.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effect: Option<crate::effect::Effect>,
    },
    ToolFinished {
        reply: String,
        call_id: String,
        name: String,
        content: String,
        #[serde(default)]
        is_error: bool,
        /// The call may or may not have taken effect (it timed out, or Spade stopped while it
        /// ran). Older events say so only in `content`; see [`crate::context::outcome_unknown`].
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        uncertain: bool,
        /// Images the tool returned (a screenshot), kept in the image store.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        /// This one result carries untrusted content although its tool usually doesn't (a
        /// workspace file written after reading the web), so the turn is untrusted from here.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        untrusted: bool,
    },
    /// What a tool showed the person (ADR 0134): images a bot made and files from its
    /// workspace, stored by hash. Stored with the tool's `tool_finished`; the model never reads
    /// it, the app shows it in the reply's bubble.
    Shared {
        reply: String,
        call_id: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        documents: Vec<DocumentRef>,
    },
    /// Where a command ran and how it went, stored right after its `tool_finished` like
    /// `shared`: whether Spade's sandbox held it, its exit, and the hosts it reached and the
    /// network policy refused. The model never reads it (its result already says how it ended);
    /// the app shows it in the reply's steps, so what a command did is seen in the conversation.
    CommandRan {
        reply: String,
        call_id: String,
        /// The sandbox held it. False when it ran outside it: the person allowed that one
        /// command, or this machine has no sandbox and it was reviewed.
        contained: bool,
        /// None when a signal ended it, or it never started.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        timed_out: bool,
        /// Hosts it reached through Spade's proxy, each once, in the order first asked.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        reached: Vec<String>,
        /// Hosts the network policy refused it, each once.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        refused: Vec<RefusedHost>,
    },
    /// An allowed call was handed to a background job. Its `tool_finished` says so at once; the
    /// job's own result comes later as `job_finished`.
    JobStarted {
        reply: String,
        job: String,
        name: String,
    },
    /// A background job ended. The model reads it like a message, so it steers an open turn or
    /// starts a new one.
    JobFinished {
        job: String,
        name: String,
        content: String,
        #[serde(default)]
        is_error: bool,
        /// The job may or may not have taken effect (lost, stopped or cut off).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        uncertain: bool,
        /// Workspace files the job kept for the person to open (a research report, ADR 0135).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        files: Vec<String>,
        /// The result carries untrusted content (a helper that read a web page, ADR 0152): the
        /// turn that reads it is untrusted, as if the bot had read that content itself.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        untrusted: bool,
        /// What the job spent on model calls (a helper's steps, ADR 0152), for the turn's cost
        /// shown to the person. Absent for jobs that make none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost_micros: Option<u64>,
    },
    // `cap_reached`, stored by builds with spending caps (ADR 0135, removed by ADR 0166), is no
    // longer a known event: it is read as raw data and folds to nothing.
    /// The model review judged a call the gate would have run (ADR 0135).
    CallReviewed {
        reply: String,
        call_id: String,
        name: String,
        verdict: Verdict,
        reason: String,
        model: String,
        #[serde(default)]
        cost_micros: u64,
        /// The hash of the files the call runs, as the reviewer read them (ADR 0144): a call
        /// approved with these runs only while they are unchanged.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bound: Option<String>,
        /// For a driving step, where it acted when it was reviewed (ADR 0171, amendment 3): the
        /// verdict holds only there, so a restart never carries it to another page or app.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acts_in: Option<Box<crate::effect::drive::Place>>,
        /// Where the call was decided to run when it was judged: the verdict holds for that
        /// launch or a narrower one only (ADR 0171, amendment 4). Absent reads as contained only.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "lenient_authorized"
        )]
        launch: Option<Authorized>,
        /// For a call Spade's classifier raised to the person (ADR 0172): the effect it read in
        /// it, which the call is then held to as well as to its own (ADR 0200 §3.4). A word this
        /// build doesn't know reads as [`crate::effect::Effect::Unknown`], never as none.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "lenient_effect"
        )]
        raised: Option<crate::effect::Effect>,
    },
    /// A bot's access level was set (ADR 0144). Spade has one level now (ADR 0163): older
    /// events naming `ask` or `full_access` read as `auto_review`.
    AccessChanged {
        level: crate::autonomy::Access,
    },
    /// The bot's task was still `working` when its reply ended, so Spade started the next step
    /// itself (ADR 0144). Stored with that step's `reply_started`; the model reads `nudge` as a
    /// note from Spade, never as the person's words.
    TaskContinued {
        step: u32,
        nudge: String,
    },
    /// Spade stopped continuing the bot's task on its own (ADR 0144): it used its step budget or
    /// made no progress. Shown to the person; the next message from anyone starts afresh.
    TaskPaused {
        reason: crate::task::PauseReason,
        steps: u32,
    },
    /// The task's goal (ADR 0159): the person's words and the criteria for done. The bot drafts
    /// one while none is open; only the person changes or replaces an open one.
    GoalSet {
        goal: String,
        title: String,
        text: String,
        criteria: Vec<crate::goal::Criterion>,
        by: crate::goal::Author,
        /// The model that checks this goal, when the person chose one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        verifier: Option<String>,
    },
    /// The person ended the goal without it being done (ADR 0159); `failed` when they ended it
    /// as failed (ADR 0164), which its episode records.
    GoalCleared {
        goal: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        failed: bool,
    },
    /// A closed goal's episode was stored (ADR 0164): what worked, what failed, what it cost.
    /// Stored once per goal, after the episode itself.
    EpisodeStored {
        goal: String,
        episode: String,
    },
    /// One change to the goal's plan (ADR 0159), from a `task_plan` call Spade accepted.
    PlanChanged {
        goal: String,
        change: crate::goal::Change,
    },
    /// An item of the plan closed with evidence (ADR 0159): where a restart resumes from.
    PlanCheckpoint {
        goal: String,
        item: String,
        done: u32,
        total: u32,
    },
    /// The verifier judged a claim that the task is done (ADR 0159). Stored before anything acts
    /// on it, so a restart reuses it.
    TaskVerified {
        goal: String,
        /// The `task_status` call that claimed done.
        claim: String,
        verdict: crate::goal::Finding,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        criteria: Vec<crate::goal::CriterionCheck>,
        /// Items whose evidence doesn't hold; they reopen.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        rejected: Vec<crate::goal::Rejected>,
        /// What is still missing, in plain words; the bot's next step reads it.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        missing: Vec<String>,
        #[serde(default)]
        model: String,
        #[serde(default)]
        cost_micros: u64,
    },
    /// Retired: a task waiting for a spending cap's reset, as an earlier build stored it. A task
    /// waits as a wake now (`wake_set {purpose: park}`, ADR 0160). Still read, and ignored: when
    /// Spade reopens the task is planned again, and parks again if the cap still holds.
    TaskParked {
        reason: crate::wake::ParkReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        until_ms: Option<i64>,
        why: String,
    },
    /// Retired: a turn waiting for its endpoint, as an earlier build stored it. A turn waits as a
    /// wake now (`wake_set {purpose: outage}`, ADR 0160). Still read: the open reply stays paused
    /// across a restart, resumes waiting until `until_ms`, and its `round` counts toward the
    /// backoff.
    TurnParked {
        reply: String,
        until_ms: i64,
        round: u32,
        why: String,
    },
    /// The person pressed Stop, naming what was running then: the open reply and the background
    /// jobs. Those stop; a result of one of those jobs, or of a job its reply started, is kept
    /// without opening a reply. Later work is not affected.
    StopRequested {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        jobs: Vec<String>,
    },
    ReplyStarted {
        reply: String,
        model: String,
    },
    /// Spade paused the open reply for a planned restart (an update or a stop): nothing of it was
    /// running when this was stored. It stays open and resumes from its events when Spade starts.
    TurnPaused {
        reply: String,
    },
    ReplyProgress {
        reply: String,
        text: String,
    },
    /// The person handed the bot's computer back after driving it (ADR 0142). `text` is Spade's
    /// summary of what they did (commands they ran, files they changed, surfaces they used),
    /// never their keystrokes. The model reads it as a note from Spade, like a job's result: it
    /// steers a turn that resumes, and opens no reply by itself.
    ComputerHandedBack {
        text: String,
        /// File names and addresses from the person's turn, kept apart from Spade's words:
        /// whoever made a file or a page chose its name, so these are untrusted data.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        data: Vec<String>,
    },
    /// What the person did on the bot's computer while they shared it (cowork, ADR 0143): Spade's
    /// summary, offered at the bot's next step boundary. Like a hand-back note it steers a turn
    /// and opens no reply by itself; the names in `data` are untrusted.
    PersonActivity {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        data: Vec<String>,
    },
    ReplyFinished {
        reply: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_tokens: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_tokens: Option<u32>,
        #[serde(default)]
        cost_micros: u64,
    },
    ReplyStopped {
        reply: String,
        text: String,
    },
    ReplyFailed {
        reply: String,
        text: String,
        /// What went wrong, as the endpoint or Spade said it: for the activity log.
        error: String,
        /// The kind of failure, for the one plain sentence a client shows. `other` on events
        /// from before it was stored, and for any kind this build doesn't know.
        #[serde(default)]
        kind: FailureKind,
        /// The endpoint the failed call went to (its id), when the failure was the endpoint's.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        endpoint: Option<String>,
    },
    ReplyInterrupted {
        reply: String,
        text: String,
    },
    /// The person pressed Try again on `reply`, the conversation's last reply, which failed. The
    /// reply stored with this one takes its place: it answers the same turn from the same history,
    /// with no message posted again, and clients show it in place of the failure.
    ReplyRetried {
        reply: String,
    },
    Renamed {
        title: String,
    },
    /// Everything before `keep_from` (an index into the conversation's events) is replaced in the
    /// model's view by `summary`; the events themselves stay stored (docs/design.md, Compaction).
    ContextCompacted {
        summary: String,
        keep_from: usize,
        #[serde(default)]
        tokens_before: u32,
        /// How many images from `keep_from` on, oldest first, the prompt describes instead of
        /// showing until the next compaction. Fixed here so prompts between compactions only grow
        /// at the end. Missing on events from before it was stored.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images_left_out: Option<usize>,
        /// What it summarised (with any earlier summary it folded in) held untrusted content, so
        /// facts drawn from it are only suggested to the person (ADR 0128).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        untrusted: bool,
        /// The writes this summary lists as already carried out, so the next compaction carries
        /// them forward instead of walking the whole conversation again. Missing on events from
        /// before it was stored; the next compaction then walks from the start once.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        carried: Option<CarriedLedger>,
    },
    /// A message in a group's transcript (ADR 0132): the person's (`from` is `None`) or a bot's
    /// answer to an ask.
    GroupMessage {
        run: String,
        text: String,
        #[serde(default)]
        from: Option<GroupBot>,
        /// The person wrote it in an ace thread (ADR 0198).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread: Option<FromThread>,
    },
    /// A group message was handed to a bot: by the person's post (`by` is `None`) or by a bot's
    /// `group_ask`.
    GroupAsked {
        run: String,
        ask: String,
        #[serde(default)]
        by: Option<GroupBot>,
        to: GroupBot,
        depth: u32,
    },
    /// An ask ended: `answered`, `stopped`, `failed`, `refused` or `gave_up`.
    GroupAnswered {
        run: String,
        ask: String,
        to: GroupBot,
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// An ask to a bot of another machine waits for that machine to come online.
    GroupQueued {
        run: String,
        ask: String,
        to: GroupBot,
        machine_name: String,
    },
    /// The person pressed Stop in the group: the run ended.
    GroupStopped {
        run: String,
    },
    /// The bot will be woken (ADR 0160): at `due_ms`, when `condition` happens, or both (a wait
    /// with a timeout). Open until a `wake_fired` or `wake_cancelled` names it.
    WakeSet {
        wake: String,
        /// The reply that set it; empty for a retry Spade parked after a reply closed.
        #[serde(default)]
        reply: String,
        purpose: crate::wake::Purpose,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        due_ms: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        condition: Option<crate::wake::Condition>,
        #[serde(default)]
        reason: String,
    },
    /// A wake fired, once. With a `note` the model reads it like a job's result, so it steers
    /// an open turn or opens a reply; `data` is untrusted text that came with it (a service's
    /// line, a thread's title). Without one (a job's end or a message settled it, or a parked
    /// job runs again) the model reads nothing more.
    WakeFired {
        wake: String,
        cause: crate::wake::Cause,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        data: Vec<String>,
    },
    /// A wake was called off before it fired.
    WakeCancelled {
        wake: String,
        by: crate::wake::CancelledBy,
    },
    /// A check-in on a background job still running (ADR 0160): the model reads it like a job's
    /// result. `tail` is the job's latest output, untrusted.
    JobProgress {
        job: String,
        name: String,
        check: u32,
        minutes: u32,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        tail: String,
    },
    /// The bot started an owned service (ADR 0160), or Spade started a `keep` one again after a
    /// restart (`restarts` counts those).
    ServiceStarted {
        service: String,
        name: String,
        command: String,
        #[serde(default)]
        cwd: String,
        #[serde(default)]
        keep: bool,
        #[serde(default, skip_serializing_if = "is_zero")]
        restarts: u32,
        /// The gate let it start only held by the sandbox (ADR 0171): started again after a
        /// restart, it is held too, or refused.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        contained_only: bool,
        /// The launch the verdict that started it was given for (ADR 0171, amendment 5). Started
        /// again after a restart it is held to that, and one with none recorded (an older
        /// build's) starts only contained.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "lenient_authorized"
        )]
        launch: Option<Authorized>,
        /// What its command ran when that verdict was given: started again where nothing holds
        /// it, it starts only while that is still so.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bound: Option<String>,
    },
    /// An owned service ended.
    ServiceEnded {
        service: String,
        cause: crate::service::Ended,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
    },
    /// This bot was made as another bot's worker (ADR 0161): the first event of its conversation.
    /// Its parent, its grants and the brief that starts it.
    WorkerOf(crate::tree::Link),
    /// This bot started a worker (ADR 0161): a bot it made, or an ace child of its `delegate`.
    WorkerStarted(crate::tree::Started),
    /// A worker of this bot settled (ADR 0161). The model reads it like a job's result.
    WorkerReported(crate::tree::Report),
    // `worker_budget` (ADR 0161, removed by ADR 0166) is read as raw data, like `cap_reached`.
    /// This worker no longer has a parent: its parent was deleted and the person kept it.
    WorkerDetached {
        by: String,
    },
    /// A choice the bot made on the person's behalf, with its reason (ADR 0165, `decision_log`).
    /// Shown in digests and the activity log; the model reads only its call's result.
    DecisionMade(crate::decision::Decision),
    /// The bot arrived from another machine (ADR 0187): consent given there doesn't count here,
    /// so no answer before this event is remembered (`since_arrival`).
    Arrived {
        /// The machine it came from, by name.
        from: String,
    },
    /// A card the bot showed (ADR 0200 §5.1), checked against its blocks' rules: its own row in
    /// the conversation. Every version is one; the chat shows the latest. The model reads only
    /// its call's result. Boxed: a card is larger than most events.
    CardShown(Box<crate::card::Shown>),
    /// The person pressed a choice on a card. Stored once per card version, and read by the bot
    /// like a job's result, as a `<card_action>`.
    CardAction {
        card: String,
        version: u32,
        action: String,
        /// The choice's label, fixed when the card was shown.
        label: String,
    },
}

/// The events after the bot's latest arrival from another machine (all of them when it never
/// moved): where the person's remembered answers are looked for, so an "Always allow" or a
/// kept answer given on another machine never counts on this one (ADR 0187).
pub fn since_arrival(events: &[Event]) -> &[Event] {
    match events
        .iter()
        .rposition(|event| matches!(event, Event::Known(Known::Arrived { .. })))
    {
        Some(at) => &events[at + 1..],
        None => events,
    }
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// Why a reply failed, in the few kinds a person can act on (`reply_failed`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// The endpoint couldn't be reached: the request never got an answer.
    Unreachable,
    /// The endpoint refused the key (`401`, `403`), or there is none.
    Key,
    /// The endpoint is rate limiting (`429`).
    RateLimited,
    /// The model or the endpoint failed while answering, or refused the request.
    Model,
    /// The bot has no model it can use: none was chosen yet, or the chosen one is no longer on
    /// the person's endpoints. Choosing one fixes it.
    NoModel,
    /// Retired (ADR 0166): a spending cap ended the reply before its next call, as builds with
    /// caps stored it. Still read: such a reply counts as finished, so its task carries on, and
    /// it reaches no one.
    Cap,
    /// Anything else, and any kind a later build adds.
    #[default]
    #[serde(other)]
    Other,
}

impl FailureKind {
    /// The kind of a failed model call.
    pub fn of(error: &spade_models::ModelError) -> Self {
        use spade_models::ModelError;
        match error {
            ModelError::MissingKey { .. } => Self::Key,
            ModelError::Unanswered { status: None, .. } => Self::Unreachable,
            ModelError::Unanswered {
                status: Some(401 | 403),
                ..
            } => Self::Key,
            ModelError::Unanswered {
                status: Some(429), ..
            } => Self::RateLimited,
            ModelError::Unanswered { .. }
            | ModelError::Provider { .. }
            | ModelError::Empty { .. }
            | ModelError::Shape { .. } => Self::Model,
            ModelError::UnknownModel(_) => Self::NoModel,
            ModelError::Listing { .. } | ModelError::Setup(_) => Self::Other,
        }
    }

    /// Whether the failure was the endpoint's, so it is worth naming.
    pub fn names_endpoint(self) -> bool {
        matches!(
            self,
            Self::Unreachable | Self::Key | Self::RateLimited | Self::Model
        )
    }
}

/// What the model review decided about a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Allow,
    Escalate,
    /// The auto-review (ADR 0144) refused the call: the bot is told why and it is not run.
    Refuse,
}

/// How a task change came about (`agent_configured`'s `change`). `by` is kept as a word, never
/// parsed into a closed set, so a word a later build adds never drops the event (and its task).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskChange {
    /// `person` (the profile, Undo, a restore) or `bot` (`task_update`).
    pub by: String,
    /// The task before this change.
    #[serde(default)]
    pub previous: String,
    /// The bot's one line on what changed, or the person's own note; empty when none was given.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub why: String,
}

/// The agent that sent a message, and how many bot-to-bot hops led to it (1 when the sender was
/// answering the person).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FromAgent {
    pub id: String,
    pub name: String,
    pub depth: u32,
    /// The machine it runs on, by name, when that is another machine (ADR 0132).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

/// Where a call may run on the person's answer, from least to most: held by the sandbox only, as
/// the sandbox finds it (held where it can be, plainly where it can't), or outside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Authorized {
    Contained,
    AsFound,
    Outside,
}

impl Authorized {
    /// What a stored limit allows: one that is absent (older events, an ambiguous request) is
    /// contained only.
    pub fn stored(limit: Option<Self>) -> Self {
        limit.unwrap_or(Self::Contained)
    }

    /// Whether a verdict given for this launch holds for one at `wanted`: the same or narrower.
    pub fn covers(self, wanted: Self) -> bool {
        self >= wanted
    }
}

/// A stored authorization read leniently: a word this build doesn't know is the narrowest.
fn lenient_authorized<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Authorized>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.map(|value| serde_json::from_value(value).unwrap_or(Authorized::Contained)))
}

fn lenient_effect<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<crate::effect::Effect>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| crate::effect::Effect::declared(&value)))
}

/// The helper behind an approval asked in its bot's conversation (ADR 0152).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelperAsk {
    /// The bot's background job the helper runs as (the id of the `helper` call).
    pub job: String,
    /// The helper's own hidden conversation.
    pub conversation: String,
    /// The call's id in the helper's conversation.
    pub call_id: String,
}

/// The group a message came through (ADR 0132), and whether the group's earlier messages that
/// came with it carry other bots' words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FromGroup {
    pub id: String,
    pub name: String,
    pub run: String,
    pub ask: String,
    /// The group lives on another machine, by name; `group_ask` works only on the group's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub untrusted: bool,
}

/// The ace thread the person wrote a message in (ADR 0198), and whether a summary of that thread
/// came with it: agents' words and tool output, so untrusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FromThread {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub untrusted: bool,
}

/// A bot as a group names it: its id, name and machine (host id; `None` for this machine).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupBot {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

/// The routine whose firing a message is (ADR 0129): its id and name, the run, and a short label
/// fixed when it fired (`9:00`, `caught up from 9:00`, `thread finished: Fix login`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FromRoutine {
    pub id: String,
    pub name: String,
    pub run: String,
    pub label: String,
    /// A heartbeat: shown as nothing, and its quiet answer too.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub heartbeat: bool,
    /// What an event carried (a thread's title), which came from outside: a turn it starts or
    /// steers counts as untrusted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    /// The routine was set up or changed in a turn that had untrusted content in view
    /// (ADR 0144): its instruction may have been planted, so a turn it starts is untrusted.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub untrusted: bool,
}

/// A host the network policy refused a command, with why (`command_ran`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefusedHost {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub reason: String,
}

/// An attached image, as stored in an event: its SHA-256 (hex), media type and size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageRef {
    pub sha256: String,
    pub media_type: String,
    pub bytes: u64,
}

/// An attached document, as stored in an event (ADR 0134): its SHA-256 (hex), name, media type
/// and size, what it holds, and the view of its text the prompt shows, fixed when it was stored so
/// a rebuilt prompt is the same bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentRef {
    pub sha256: String,
    pub name: String,
    pub media_type: String,
    pub bytes: u64,
    /// A PDF's page count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<u32>,
    /// A spreadsheet's sheet count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheets: Option<u32>,
    /// Characters of extracted text.
    pub chars: u64,
    /// The text stopped at Spade's limit; the document holds more.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
    /// The start of the text, as the prompt shows it.
    #[serde(default)]
    pub view: String,
    /// Which reader made the text, and its version (`pdf-v1`): the same bytes read as another
    /// kind, or by a later reader, are another text. Empty on references made before it was kept.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reader: String,
}

impl DocumentRef {
    /// The id the model reads the document by: the hash's first 12 characters, then the reader.
    pub fn handle(&self) -> String {
        let short: String = self.sha256.chars().take(12).collect();
        if self.reader.is_empty() {
            short
        } else {
            format!("{short}-{}", self.reader)
        }
    }
}

/// A spoken message's recording: its SHA-256 (hex), media type and size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceRef {
    pub sha256: String,
    pub media_type: String,
    pub bytes: u64,
}

/// A tool call as stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// Token counts for a model call, as the endpoint reported them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u32>,
}

/// A stored event. One Spade does not know (written by a newer version) is kept as raw JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Known(Known),
    Unknown(Value),
}

/// How a reply ended, other than finishing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyEnd {
    Stopped,
    Interrupted,
}

impl Event {
    pub fn from_json(value: Value) -> Self {
        match serde_json::from_value::<Known>(value.clone()) {
            Ok(known) => Self::Known(known),
            Err(_) => Self::Unknown(value),
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Known(known) => serde_json::to_value(known).unwrap_or(Value::Null),
            Self::Unknown(value) => value.clone(),
        }
    }

    pub fn user_message(text: impl Into<String>) -> Self {
        Self::Known(Known::UserMessage {
            text: text.into(),
            context: None,
            images: Vec::new(),
            documents: Vec::new(),
            voice: None,
            from_agent: None,
            from_routine: None,
            from_group: None,
            from_thread: None,
        })
    }

    pub fn reply_started(reply: impl Into<String>, model: impl Into<String>) -> Self {
        Self::Known(Known::ReplyStarted {
            reply: reply.into(),
            model: model.into(),
        })
    }

    pub fn reply_progress(reply: impl Into<String>, text: impl Into<String>) -> Self {
        Self::Known(Known::ReplyProgress {
            reply: reply.into(),
            text: text.into(),
        })
    }

    pub fn reply_ended(end: ReplyEnd, reply: impl Into<String>, text: impl Into<String>) -> Self {
        let (reply, text) = (reply.into(), text.into());
        Self::Known(match end {
            ReplyEnd::Stopped => Known::ReplyStopped { reply, text },
            ReplyEnd::Interrupted => Known::ReplyInterrupted { reply, text },
        })
    }

    pub fn renamed(title: impl Into<String>) -> Self {
        Self::Known(Known::Renamed {
            title: title.into(),
        })
    }
}

/// The "already carried out" list a compaction wrote (ADR 0158): one line per write, newest last.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CarriedLedger {
    pub writes: Vec<CarriedWrite>,
    /// Older writes no longer listed one by one, so the list stays bounded over weeks.
    #[serde(default, skip_serializing_if = "is_none_earlier")]
    pub earlier: u64,
}

fn is_none_earlier(n: &u64) -> bool {
    *n == 0
}

/// One write in a compaction's "already carried out" list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CarriedWrite {
    pub call_id: String,
    /// The tool, call id and arguments, trimmed to one line.
    pub what: String,
    /// What became of it ("" when done).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    /// Its background job had not ended when this list was written; the next compaction looks
    /// again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub running: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn known_events_round_trip_through_json() {
        let event = Event::Known(Known::ReplyFinished {
            reply: "r1".into(),
            text: "Hi".into(),
            input_tokens: Some(11),
            output_tokens: None,
            cost_micros: 42,
        });
        assert_eq!(Event::from_json(event.to_json()), event);
        assert_eq!(event.to_json()["type"], "reply_finished");
    }

    #[test]
    fn an_event_from_a_newer_spade_is_kept_not_dropped() {
        let raw = json!({ "type": "tool_called", "tool": "web_search" });
        assert_eq!(Event::from_json(raw.clone()), Event::Unknown(raw.clone()));
        assert_eq!(Event::from_json(raw.clone()).to_json(), raw);
    }

    fn failed_kind(raw: Value) -> Option<FailureKind> {
        match Event::from_json(raw) {
            Event::Known(Known::ReplyFailed { kind, .. }) => Some(kind),
            _ => None,
        }
    }

    #[test]
    fn a_failed_reply_stored_before_kinds_existed_or_with_a_newer_kind_reads_as_other() {
        let old = json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "boom" });
        assert_eq!(failed_kind(old), Some(FailureKind::Other));
        let newer = json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "boom",
                            "kind": "solar_flare" });
        assert_eq!(failed_kind(newer), Some(FailureKind::Other));
        let known = json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "boom",
                            "kind": "rate_limited", "endpoint": "fake" });
        assert_eq!(failed_kind(known), Some(FailureKind::RateLimited));
    }

    #[test]
    fn a_call_that_never_got_an_answer_is_unreachable_and_a_refused_key_is_the_keys() {
        use spade_models::ModelError;
        let refused = |status: Option<u16>| ModelError::Unanswered {
            model: "fake/m".into(),
            message: String::new(),
            transient: false,
            retry_after: None,
            status,
        };
        assert_eq!(FailureKind::of(&refused(None)), FailureKind::Unreachable);
        assert_eq!(FailureKind::of(&refused(Some(401))), FailureKind::Key);
        assert_eq!(
            FailureKind::of(&refused(Some(429))),
            FailureKind::RateLimited
        );
        assert_eq!(FailureKind::of(&refused(Some(500))), FailureKind::Model);
        let missing = ModelError::MissingKey {
            endpoint: "fake".into(),
            var: None,
        };
        assert_eq!(FailureKind::of(&missing), FailureKind::Key);
    }

    #[test]
    fn a_reply_without_a_usable_model_fails_as_no_model_and_says_what_to_do() {
        use spade_models::ModelError;
        let unchosen = ModelError::UnknownModel(String::new());
        assert_eq!(FailureKind::of(&unchosen), FailureKind::NoModel);
        assert!(
            unchosen
                .to_string()
                .contains("no model is chosen yet: choose one")
        );
        let gone = ModelError::UnknownModel("old/m".into());
        assert_eq!(FailureKind::of(&gone), FailureKind::NoModel);
        assert_eq!(
            gone.to_string(),
            "old/m is not a model on one of your endpoints"
        );
        let stored = Event::Known(Known::ReplyFailed {
            reply: "r1".into(),
            text: String::new(),
            error: unchosen.to_string(),
            kind: FailureKind::NoModel,
            endpoint: None,
        })
        .to_json();
        assert_eq!(stored["kind"], "no_model");
    }
}
