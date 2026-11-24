//! `research` (ADR 0135, spade/docs/oversight.md): a background tool that splits a question into
//! parts and runs one read-only `explore` helper for each, side by side, on the `helper` role.
//! The helpers search and read lean through `web_search` and `web_fetch`'s outline and passages;
//! this collects what each cited, has the answer summarised, and saves a compact report that
//! names the page and saved workspace path behind every finding. The decisions are
//! `spade_core::research`; this is the I/O around them.

use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{FuturesUnordered, StreamExt};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::research::{self, Budget, Depth, Plan, Summary};
use spade_core::routing::Role;
use spade_core::tools::{Risk, ToolDef};
use spade_models::{Effort, Prompt, ToolSpec};
use spade_store::StoredHelper;
use tokio::time::Instant;

use crate::engine::{Admission, Engine};
use crate::tools::{EngineHandle, Tool, ToolFuture, ToolOutput, parse};
use crate::workspace::Workspaces;

/// Where reports go in the workspace.
const FOLDER: &str = "research";
const STATUS: &str = "Researching";
/// Reports with one name before saving gives up.
const MOST_SAME_NAME: usize = 1_000;
/// How long the first helper is given to begin answering before the rest start anyway: its
/// request writes the provider's cache for the prompt top every helper shares.
const STAGGER_WAIT: Duration = Duration::from_secs(20);

pub struct ResearchTool {
    workspaces: Workspaces,
    bots: EngineHandle,
    /// Replaces every depth's budget (tests).
    budget: Option<Budget>,
}

impl ResearchTool {
    pub fn new(workspaces: Workspaces, bots: EngineHandle) -> Self {
        Self {
            workspaces,
            bots,
            budget: None,
        }
    }

    /// Every run gets `budget`, whatever its depth.
    #[must_use]
    pub fn with_budget(mut self, budget: Budget) -> Self {
        self.budget = Some(budget);
        self
    }
}

#[derive(Deserialize)]
struct Args {
    question: String,
    #[serde(default)]
    depth: Depth,
}

impl Tool for ResearchTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: research::TOOL.to_owned(),
                description: "Research a question on the web with a team of helpers: splits it \
                              into parts, runs them side by side as read-only helpers that search \
                              and read only the sections of a page they need, and gives you a \
                              compact report — the answer, findings each with its source URL and \
                              the page saved in your workspace, disagreements or gaps, and how \
                              far to trust it. It is saved under research/ too. Runs in the \
                              background; the report arrives as the job's result. Use it for \
                              questions that need several sources; depth is quick (3 helpers), \
                              standard (4) or deep (6)."
                    .to_owned(),
                schema: json!({ "type": "object",
                                "properties": {
                                    "question": { "type": "string" },
                                    "depth": { "type": "string", "enum": ["quick", "standard", "deep"],
                                               "description": "How many helpers and pages: quick 3 helpers and 2 pages each, standard (the default) 4 and 3, deep 6 and 5." } },
                                "required": ["question"] }),
            },
            risk: Risk::Read,
            untrusted_output: true,
            deferred: false,
            background: true,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        // A research part's helpers are stored under this job (`<job>/<n>`), so Stop and a
        // restart find them with the research.
        let (conversation, job) = match key.split_once('.') {
            Some((conversation, job)) => (conversation.to_owned(), job.to_owned()),
            None => (key.to_owned(), "research".to_owned()),
        };
        let (workspaces, bots, fixed) = (self.workspaces.clone(), self.bots.clone(), self.budget);
        Box::pin(async move {
            let args: Args = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let question = args.question.trim().to_owned();
            if question.is_empty() {
                return ToolOutput::error("Give the question to research.");
            }
            let Some(engine) = bots.get() else {
                return ToolOutput::error("Spade is starting; try again in a moment.");
            };
            let Some(bot) = engine.agent_of(&conversation) else {
                return ToolOutput::error("This conversation has no bot, so no workspace.");
            };
            // The plan, the answer and the report's words are small typed calls: the fast role,
            // like the helpers themselves.
            let model = engine.role_model(&conversation, Role::Helper);
            if model.is_empty() {
                return ToolOutput::error(
                    "Research needs a model on one of the person's endpoints.",
                );
            }
            let run = Run {
                engine: engine.clone(),
                conversation: conversation.clone(),
                job,
                model,
                effort: engine.role_effort(&conversation, Role::Helper),
                budget: fixed.unwrap_or_else(|| args.depth.budget()),
                started: Instant::now(),
                stopped: None,
            };
            let output = run.go(&question, &workspaces, &bot).await;
            engine.job_status(&conversation, STATUS, None);
            output
        })
    }
}

/// One research run's state.
struct Run {
    engine: Arc<Engine>,
    conversation: String,
    /// The bot's job this run is, which its part helpers are stored under.
    job: String,
    model: String,
    effort: Effort,
    budget: Budget,
    started: Instant,
    /// Why it stopped early, once it has.
    stopped: Option<String>,
}

impl Run {
    fn status(&self, words: Option<String>) {
        let shown = match words {
            Some(words) => format!("{STATUS} · {words}"),
            None => STATUS.to_owned(),
        };
        self.engine
            .job_status(&self.conversation, STATUS, Some(shown));
    }

    fn time_left(&self) -> Option<Duration> {
        Duration::from_millis(self.budget.time_ms).checked_sub(self.started.elapsed())
    }

    /// Whether another model call may start; records why not when it may not.
    fn may_call(&mut self) -> bool {
        if self.stopped.is_some() {
            return false;
        }
        let why = if self.time_left().is_none() {
            Some("the time budget".to_owned())
        } else {
            None
        };
        self.stopped = why;
        self.stopped.is_none()
    }

    /// The admission for one model call, paid for under the bot (ADR 0135).
    fn admit(&self) -> Admission {
        self.engine.admit(&self.conversation, &self.model)
    }

    async fn typed<T>(&mut self, prompt: Prompt) -> Option<T>
    where
        T: JsonSchema + serde::de::DeserializeOwned,
    {
        let prompt = prompt.session(&self.conversation).effort(self.effort);
        let limit = self.time_left()?;
        let admitted = self.admit();
        let answer = tokio::time::timeout(
            limit,
            self.engine.models().generate::<T>(&self.model, &prompt),
        )
        .await;
        match answer {
            Ok(Ok(generated)) => {
                admitted.settle(&generated.usage);
                Some(generated.value)
            }
            Ok(Err(error)) => {
                admitted.settle_if(error.usage());
                None
            }
            Err(_) => {
                self.stopped = Some("the time budget".to_owned());
                None
            }
        }
    }

    async fn go(mut self, question: &str, workspaces: &Workspaces, bot: &str) -> ToolOutput {
        self.status(None);
        let plan = if self.may_call() {
            self.typed::<Plan>(research::plan_prompt(question, self.budget))
                .await
        } else {
            None
        };
        let title = plan
            .as_ref()
            .map(|plan| plan.title.trim())
            .filter(|title| !title.is_empty())
            .unwrap_or(question)
            .to_owned();
        let questions = match plan {
            Some(plan) => research::tidy(plan, question, self.budget),
            None => research::tidy(
                Plan {
                    title: String::new(),
                    questions: Vec::new(),
                },
                question,
                self.budget,
            ),
        };
        let parts = self.gather(question, &questions).await;
        if parts.is_empty() || parts.iter().all(|part| part.failure.is_some()) {
            let why = self
                .stopped
                .clone()
                .map_or_else(String::new, |w| format!(" It reached {w}."));
            let said = parts
                .first()
                .and_then(|part| part.failure.clone())
                .map_or_else(String::new, |why| format!(" {why}"));
            return ToolOutput::error(format!(
                "Research found nothing it could report for \"{question}\".{why}{said}"
            ))
            .untrusted();
        }
        self.status(Some("writing the report".to_owned()));
        let summary = if self.may_call() {
            self.typed::<Summary>(research::summary_prompt(question, &parts))
                .await
        } else {
            None
        };
        let report = research::assemble(&title, summary.as_ref(), &parts, self.stopped.as_deref());
        let path = match self.save(workspaces, bot, &title, &report).await {
            Ok(path) => path,
            Err(why) => {
                return ToolOutput::error(format!("The report could not be saved: {why}"))
                    .untrusted();
            }
        };
        let out = research::result(&report, &path, &parts);
        let mut output = ToolOutput::ok(out).untrusted();
        output.files = Box::new([path]);
        output
    }

    /// Starts the helpers a batch at a time: the first alone until it has begun answering, then
    /// the rest together. Waits for all of them, stopping any still running at the time budget.
    async fn gather(
        &mut self,
        question: &str,
        questions: &[research::PlanQuestion],
    ) -> Vec<research::Part> {
        // Helpers are stored in the bot's conversation.
        let conversation = self.conversation.clone();
        let mut parts: Vec<Option<research::Part>> = (0..questions.len()).map(|_| None).collect();
        let mut started: Vec<(usize, StoredHelper)> = Vec::new();
        for (batch, range) in research::batches(questions.len()).into_iter().enumerate() {
            for n in range {
                let task = research::helper_task(question, &questions[n], self.budget.pages);
                match self
                    .engine
                    .start_research_part(&conversation, &self.job, n, &task)
                {
                    Ok(helper) => started.push((n, helper)),
                    Err(why) => {
                        parts[n] = Some(research::failed(&questions[n].question, &why));
                    }
                }
            }
            self.engine.fill_slots(&conversation);
            if batch == 0
                && let Some((_, first)) = started.first()
            {
                let limit = self.time_left().unwrap_or_default().min(STAGGER_WAIT);
                let _ = self.engine.part_answering(first, limit).await;
            }
        }
        if started.is_empty() {
            return parts.into_iter().flatten().collect();
        }
        let mut waiting = FuturesUnordered::new();
        for (n, helper) in started {
            let engine = self.engine.clone();
            let limit = self.time_left().unwrap_or_default();
            waiting.push(async move {
                let end = engine.wait_part_end(&helper, limit).await;
                (n, end)
            });
        }
        let mut back = 0;
        while let Some((n, end)) = waiting.next().await {
            back += 1;
            self.status(Some(format!("{back} of {} helpers back", questions.len())));
            parts[n] = Some(match end {
                Some(end) if !end.is_error => {
                    research::read_reply(&questions[n].question, &end.content, &end.pages)
                }
                Some(end) => research::failed(&questions[n].question, &end.content),
                None => {
                    research::failed(&questions[n].question, "it ran out of time and was stopped")
                }
            });
        }
        parts.into_iter().flatten().collect()
    }

    /// Saves the report under `research/`, beside earlier ones; never added to the trust record.
    async fn save(
        &self,
        workspaces: &Workspaces,
        bot: &str,
        title: &str,
        report: &str,
    ) -> Result<String, String> {
        let workspace = workspaces.of(bot).map_err(|e| e.to_string())?;
        let date = jiff::Timestamp::from_millisecond(self.engine.now_ms())
            .map(|t| t.to_zoned(self.engine.zone()).date().to_string())
            .unwrap_or_default();
        let stem = format!("{FOLDER}/{date}-{}", research::slug(title));
        let report = report.to_owned();
        tokio::task::spawn_blocking(move || {
            // Created only where nothing is: a report written at the same moment under the
            // same name takes the next suffix instead of replacing this one.
            for n in 1..=MOST_SAME_NAME {
                let path = if n == 1 {
                    format!("{stem}.md")
                } else {
                    format!("{stem}-{n}.md")
                };
                if workspace
                    .create_new(&path, &report)
                    .map_err(|e| e.to_string())?
                {
                    return Ok(path);
                }
            }
            Err(format!("{MOST_SAME_NAME} reports already have this name"))
        })
        .await
        .map_err(|_| "the file work stopped".to_owned())?
    }
}
