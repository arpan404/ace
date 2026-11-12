//! `research` (ADR 0135, spade/docs/oversight.md): a background tool that plans sub-questions,
//! searches and reads pages in parallel within budgets of time, pages and spend, has the bot's
//! model write a report that cites its sources by number, checks it against them, and keeps it
//! in the bot's workspace. The decisions are `spade_core::research`; this is the I/O around them.

pub mod web;

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::stream;
use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::research::{
    self, Budget, Check, Checked, Depth, Hit, Plan, PlanQuestion, SOURCE_CHARS, Source,
};
use spade_core::tools::{Risk, ToolDef};
use spade_models::{Prompt, ToolSpec};
use tokio::time::Instant;

use crate::engine::{Admission, Engine, Hint};
use crate::tools::{EngineHandle, Tool, ToolFuture, ToolOutput, parse};
use crate::workspace::Workspaces;
pub use web::{LiveWeb, Read, Web};

/// Searches and page reads at once.
const PARALLEL: usize = 4;
/// Results asked of each search.
const RESULTS_PER_QUERY: usize = 8;
/// Where reports go in the workspace.
const FOLDER: &str = "research";
const STATUS: &str = "Researching";
/// Reports with one name before saving gives up.
const MOST_SAME_NAME: usize = 1_000;

pub struct ResearchTool {
    web: Arc<dyn Web>,
    workspaces: Workspaces,
    bots: EngineHandle,
    /// Replaces every depth's budget (tests).
    budget: Option<Budget>,
}

impl ResearchTool {
    pub fn new(web: Arc<dyn Web>, workspaces: Workspaces, bots: EngineHandle) -> Self {
        Self {
            web,
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
                name: "research".to_owned(),
                description: "Research a question in depth on the web: plans sub-questions, reads \
                              many sources, cross-checks them and writes a report with numbered \
                              sources into your workspace. Runs in the background; you get a \
                              summary and the report's path. Use it for questions that need more \
                              than a few pages; depth is quick (a few cents, about 6 pages), \
                              standard (about 15) or deep (about 30)."
                    .to_owned(),
                schema: json!({ "type": "object",
                                "properties": {
                                    "question": { "type": "string" },
                                    "depth": { "type": "string", "enum": ["quick", "standard", "deep"] } },
                                "required": ["question"] }),
            },
            risk: Risk::Read,
            untrusted_output: true,
            deferred: false,
            background: true,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let conversation = key.split_once('.').map_or(key, |(c, _)| c).to_owned();
        let (web, workspaces, bots, fixed) = (
            self.web.clone(),
            self.workspaces.clone(),
            self.bots.clone(),
            self.budget,
        );
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
            let run = Run {
                engine: engine.clone(),
                conversation: conversation.clone(),
                model: engine.bot_model(&conversation),
                web,
                budget: fixed.unwrap_or_else(|| args.depth.budget()),
                started: Instant::now(),
                spent: 0,
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
    model: String,
    web: Arc<dyn Web>,
    budget: Budget,
    started: Instant,
    spent: u64,
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
        let why = if self.spent >= self.budget.spend_micros {
            Some("the spend budget".to_owned())
        } else if self.time_left().is_none() {
            Some("the time budget".to_owned())
        } else {
            None
        };
        self.stopped = why;
        self.stopped.is_none()
    }

    /// Admits one model call against the caps (ADR 0135), waiting within the time budget while
    /// only calls still running stand in the way; records why not when a cap is reached or the
    /// time runs out first.
    async fn admit(&mut self, prompt: &Prompt) -> Option<Admission> {
        let limit = self.time_left()?;
        let waiting =
            self.engine
                .admit_waiting(&self.conversation, &self.model, prompt, Hint::default());
        match tokio::time::timeout(limit, waiting).await {
            Ok(Ok(admitted)) => Some(admitted),
            Ok(Err(refused)) => {
                self.stopped = Some(refused.reached());
                None
            }
            Err(_) => {
                self.stopped = Some("the time budget".to_owned());
                None
            }
        }
    }

    async fn typed<T>(&mut self, prompt: Prompt) -> Option<T>
    where
        T: schemars::JsonSchema + serde::de::DeserializeOwned,
    {
        let prompt = prompt.session(&self.conversation);
        let limit = self.time_left()?;
        let admitted = self.admit(&prompt).await?;
        let answer = tokio::time::timeout(
            limit,
            self.engine.models().generate::<T>(&self.model, &prompt),
        )
        .await;
        match answer {
            Ok(Ok(generated)) => {
                self.spent += admitted.settle(&generated.usage);
                Some(generated.value)
            }
            Ok(Err(error)) => {
                self.spent += admitted.settle_if(error.usage());
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
        let mut title = question.to_owned();
        let plan = if self.may_call() {
            self.typed::<Plan>(research::plan_prompt(question, self.budget))
                .await
        } else {
            None
        };
        let questions = match plan {
            Some(plan) => {
                if !plan.title.trim().is_empty() {
                    title = plan.title.trim().to_owned();
                }
                research::tidy(plan, question, self.budget)
            }
            None => research::tidy(
                Plan {
                    title: String::new(),
                    questions: Vec::new(),
                },
                question,
                self.budget,
            ),
        };
        let sources = self.gather(question, &questions).await;
        if sources.is_empty() {
            let why = self
                .stopped
                .clone()
                .map_or_else(String::new, |w| format!(" It reached {w}."));
            return ToolOutput::error(format!(
                "Research found no pages it could read for \"{question}\".{why}"
            ))
            .untrusted();
        }
        self.status(Some("writing the report".to_owned()));
        let body = self.write(question, &questions, &sources).await;
        let checked = match &body {
            Ok(text) if self.may_call() => match self
                .typed::<Check>(research::check_prompt(text, &sources))
                .await
            {
                Some(check) => Checked::Ran(check.unsupported),
                None => Checked::Not(match &self.stopped {
                    Some(why) => format!("it reached {why}"),
                    None => "the check gave no usable answer".to_owned(),
                }),
            },
            Ok(_) => Checked::Not(format!(
                "it reached {}",
                self.stopped.clone().unwrap_or_default()
            )),
            Err(_) => Checked::Not("there was no report to check".to_owned()),
        };
        let body = body.unwrap_or_else(|why| {
            format!(
                "## Summary\n\nSpade read {} sources but could not write the report: {why}.",
                sources.len()
            )
        });
        let report = research::assemble(&title, &body, &checked, self.stopped.as_deref(), &sources);
        let path = match self.save(workspaces, bot, &title, &report).await {
            Ok(path) => path,
            Err(why) => {
                return ToolOutput::error(format!("The report could not be saved: {why}"))
                    .untrusted();
            }
        };
        // Summarised from the report as saved: citations fixed, warnings included.
        let out = research::result(
            &report,
            &checked,
            self.stopped.as_deref(),
            &path,
            sources.len(),
        );
        let mut output = ToolOutput::ok(out).untrusted();
        output.files = vec![path];
        output
    }

    /// Searches every query, picks the pages and reads them, numbered in the order they come back.
    async fn gather(&mut self, question: &str, questions: &[PlanQuestion]) -> Vec<Source> {
        let queries: Vec<(usize, String)> = questions
            .iter()
            .enumerate()
            .flat_map(|(i, q)| q.queries.iter().map(move |query| (i, query.clone())))
            .collect();
        let Some(limit) = self.time_left() else {
            self.stopped = Some("the time budget".to_owned());
            return Vec::new();
        };
        let web = self.web.clone();
        let searched: Vec<(usize, Vec<Hit>)> = tokio::time::timeout(
            limit,
            stream::iter(queries)
                .map(|(i, query)| {
                    let web = web.clone();
                    async move {
                        (
                            i,
                            web.search(&query, RESULTS_PER_QUERY)
                                .await
                                .unwrap_or_default(),
                        )
                    }
                })
                .buffered(PARALLEL)
                .collect::<Vec<_>>(),
        )
        .await
        .unwrap_or_default();
        let mut per_question: Vec<Vec<Hit>> = vec![Vec::new(); questions.len()];
        for (i, hits) in searched {
            per_question[i].extend(hits);
        }
        let picked = research::pick(&per_question, self.budget.pages);
        let mut wanted: Vec<String> = questions.iter().map(|q| q.question.clone()).collect();
        wanted.push(question.to_owned());
        let mut reads = stream::iter(picked)
            .map(|hit| {
                let web = web.clone();
                async move { (hit.clone(), web.read(&hit.url).await) }
            })
            .buffer_unordered(PARALLEL);
        let mut sources = Vec::new();
        loop {
            let Some(limit) = self.time_left() else {
                self.stopped = Some("the time budget".to_owned());
                break;
            };
            let next = match tokio::time::timeout(limit, reads.next()).await {
                Ok(Some(next)) => next,
                Ok(None) => break,
                Err(_) => {
                    self.stopped = Some("the time budget".to_owned());
                    break;
                }
            };
            let (hit, Ok(read)) = next else { continue };
            let passages = research::passages(&read.text, &wanted, SOURCE_CHARS);
            if passages.is_empty() {
                continue;
            }
            let title = if read.title.trim().is_empty() {
                hit.title
            } else {
                read.title
            };
            sources.push(Source {
                n: sources.len() + 1,
                url: read.url,
                title,
                passages,
            });
            let read = sources.len();
            self.status(Some(if read == 1 {
                "1 source read".to_owned()
            } else {
                format!("{read} sources read")
            }));
        }
        sources
    }

    async fn write(
        &mut self,
        question: &str,
        questions: &[PlanQuestion],
        sources: &[Source],
    ) -> Result<String, String> {
        if !self.may_call() {
            return Err(format!(
                "it reached {}",
                self.stopped.clone().unwrap_or_default()
            ));
        }
        let prompt =
            research::write_prompt(question, questions, sources).session(&self.conversation);
        let limit = self.time_left().ok_or("it reached the time budget")?;
        let Some(admitted) = self.admit(&prompt).await else {
            return Err(format!(
                "it reached {}",
                self.stopped.clone().unwrap_or_default()
            ));
        };
        match tokio::time::timeout(limit, self.engine.models().chat(&self.model, &prompt)).await {
            Ok(Ok(reply)) => {
                self.spent += admitted.settle(&reply.usage);
                let text = reply.text.trim().to_owned();
                if text.is_empty() {
                    Err("the model wrote nothing".to_owned())
                } else {
                    Ok(text)
                }
            }
            Ok(Err(error)) => {
                self.spent += admitted.settle_if(error.usage());
                Err(error.to_string())
            }
            Err(_) => {
                self.stopped = Some("the time budget".to_owned());
                Err("it reached the time budget".to_owned())
            }
        }
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
