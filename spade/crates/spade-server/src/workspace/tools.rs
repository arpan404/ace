//! The workspace's file tools a bot is offered: `workspace_list`, `workspace_read`,
//! `workspace_search`, `workspace_find`, `workspace_write` and `workspace_edit`; `shell` and
//! `python` are in `shell_tool.rs` and `python.rs`. Each finds the calling bot from the call's key
//! and works only in that bot's folder.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::shell::Shell;
use super::shell_tool::ShellTool;
use super::{PathError, Workspace, Workspaces};
use crate::tools::{EngineHandle, Tool, ToolFuture, ToolOutput, TurnFacts, parse};

/// The shell's deadline when the model names none. The model may name any longer one (ADR
/// 0158); a command still running after the engine's foreground window moves to the background
/// and its result arrives as a `<job_result>`.
pub const SHELL_TIMEOUT: Duration = Duration::from_secs(60);

/// What every workspace tool shares: where workspaces are and who is calling.
#[derive(Clone)]
pub(super) struct Place {
    pub(super) all: Workspaces,
    pub(super) bots: EngineHandle,
}

impl Place {
    /// Tells the app's live views that files changed in the calling bot's workspace.
    pub(super) fn files_changed(&self, key: &str, paths: Option<Vec<String>>) {
        if let (Some(engine), Some(bot)) = (self.bots.get(), self.bots.agent_for_key(key))
            && let Some(computers) = engine.computers()
        {
            computers.files_changed(&bot, paths);
        }
    }

    /// The bot yields to the person (cowork, ADR 0143): a file the person changed a moment ago
    /// is theirs for now, so the bot's write or edit of it is not run.
    fn yields(&self, key: &str, path: &str) -> Option<ToolOutput> {
        let (engine, bot) = (self.bots.get()?, self.bots.agent_for_key(key)?);
        let ago = engine.computers()?.person_changed_recently(&bot, path)?;
        Some(ToolOutput::ok(format!(
            "Not run: the person changed {path} {ago} seconds ago and may still be working on \
             it; they come first. Leave it for now: work on something else and read it again \
             before you change it."
        )))
    }

    pub(super) fn workspace(&self, key: &str) -> Result<Workspace, ToolOutput> {
        let bot = self
            .bots
            .agent_for_key(key)
            .ok_or_else(|| ToolOutput::error("This conversation has no bot, so no workspace."))?;
        self.all
            .of(&bot)
            .map_err(|error| ToolOutput::error(error.to_string()))
    }
}

/// Where the bot's `shell` commands run: each on its own (`Shell`), or in the bot's persistent
/// terminal (ADR 0142), which the person can watch and take over.
#[derive(Clone)]
pub enum Commands {
    OneShot(Shell),
    Terminal(Arc<crate::computer::Terminals>),
}

impl Commands {
    /// Whether a command with home `home` runs contained in the bot's OS sandbox (ADR 0167).
    pub(super) fn contains(&self, home: &std::path::Path) -> bool {
        match self {
            Self::OneShot(shell) => shell.contains(home),
            Self::Terminal(terminals) => terminals.contains(home),
        }
    }

    /// Whether the bot with home `home` runs its commands outside the sandbox (ADR 0171).
    pub(super) fn outside(&self, home: &std::path::Path) -> bool {
        match self {
            Self::OneShot(shell) => shell.outside(home),
            Self::Terminal(terminals) => terminals.outside(home),
        }
    }
}

impl From<Shell> for Commands {
    fn from(shell: Shell) -> Self {
        Self::OneShot(shell)
    }
}

impl From<Arc<crate::computer::Terminals>> for Commands {
    fn from(terminals: Arc<crate::computer::Terminals>) -> Self {
        Self::Terminal(terminals)
    }
}

/// Every workspace tool, for `bots` (set once the engine exists), running shell commands with
/// `commands`.
pub fn tools(
    all: Workspaces,
    bots: EngineHandle,
    commands: impl Into<Commands>,
) -> Vec<Arc<dyn Tool>> {
    tools_with(all, bots, commands, super::python::Setup::system())
}

/// [`tools`], with `python` finding and setting up Python as `python` says.
pub fn tools_with(
    all: Workspaces,
    bots: EngineHandle,
    commands: impl Into<Commands>,
    python: super::python::Setup,
) -> Vec<Arc<dyn Tool>> {
    let shell = commands.into();
    let place = Place { all, bots };
    let commands = ShellTool { place, shell };
    vec![
        Arc::new(WorkspaceList(commands.place.clone())),
        Arc::new(WorkspaceRead(commands.place.clone())),
        Arc::new(WorkspaceSearch(commands.place.clone())),
        Arc::new(WorkspaceFind(commands.place.clone())),
        Arc::new(WorkspaceWrite(commands.place.clone())),
        Arc::new(WorkspaceEdit(commands.place.clone())),
        Arc::new(super::python::PythonTool::new(commands.clone(), python)),
        Arc::new(commands),
    ]
}

fn def(name: &str, description: &str, schema: Value, risk: Risk) -> ToolDef {
    shown_def(name, description, schema, risk, false)
}

pub(super) fn shown_def(
    name: &str,
    description: &str,
    schema: Value,
    risk: Risk,
    untrusted_output: bool,
) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            schema,
        },
        risk,
        untrusted_output,
        deferred: false,
        background: false,
    }
}

/// Runs file work off the async threads and turns its error into words for the model.
fn blocking(
    place: &Place,
    key: &str,
    work: impl FnOnce(Workspace) -> Result<ToolOutput, PathError> + Send + 'static,
) -> ToolFuture {
    let workspace = place.workspace(key);
    Box::pin(async move {
        let workspace = match workspace {
            Ok(workspace) => workspace,
            Err(output) => return output,
        };
        tokio::task::spawn_blocking(move || work(workspace))
            .await
            .unwrap_or_else(|_| Err(PathError::Io("the file work stopped".to_owned())))
            .unwrap_or_else(|error| ToolOutput::error(error.to_string()))
    })
}

/// A file name for a call's large output, from its key.
pub(super) fn output_name(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

pub struct WorkspaceList(Place);

#[derive(Deserialize)]
struct ListArgs {
    #[serde(default)]
    path: String,
}

/// A result, marked untrusted unless everything it shows is trusted.
fn marked(output: ToolOutput, trusted: bool) -> ToolOutput {
    if trusted { output } else { output.untrusted() }
}

impl Tool for WorkspaceList {
    fn def(&self) -> ToolDef {
        def(
            "workspace_list",
            "Lists a folder in your workspace (your own folder on this machine for files you \
             keep and work on). Paths are relative to the workspace; leave path empty for its top.",
            json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
            Risk::Read,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let args: ListArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        blocking(&self.0, key, move |workspace| {
            let listing = workspace.list(&args.path)?;
            // Names are content too: trusted only when every entry shown is a trusted file.
            let trusted = workspace.listing_trusted(&listing);
            if listing.entries.is_empty() {
                return Ok(marked(ToolOutput::ok("The folder is empty."), trusted));
            }
            let mut lines: Vec<String> = listing
                .entries
                .iter()
                .map(|entry| match entry.kind {
                    super::EntryKind::Folder => format!("{}/", entry.path),
                    super::EntryKind::Link => format!("{} (link)", entry.path),
                    super::EntryKind::File => format!("{} ({} bytes)", entry.path, entry.size),
                })
                .collect();
            if listing.truncated {
                lines.push(format!("[Only the first {} shown.]", lines.len()));
            }
            Ok(marked(ToolOutput::ok(lines.join("\n")), trusted))
        })
    }
}

pub struct WorkspaceRead(Place);

#[derive(Deserialize)]
struct ReadArgs {
    path: String,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

/// What a read found, before anything is stored: a file is read off the async threads, and a
/// document's text is made by the media reader.
enum Read {
    Text(String),
    Image(Vec<u8>),
    Document(Vec<u8>),
}

impl Tool for WorkspaceRead {
    fn def(&self) -> ToolDef {
        def(
            "workspace_read",
            "Reads a file in your workspace. Text comes as numbered lines, a window at a time: \
             offset is the first line (from 1), limit how many (400 unless given). An image \
             (PNG, JPEG, GIF, WebP) comes as the image; a PDF, Word or Excel file as its text.",
            json!({ "type": "object",
                    "properties": { "path": { "type": "string" },
                                    "offset": { "type": "integer", "minimum": 1 },
                                    "limit": { "type": "integer", "minimum": 1 } },
                    "required": ["path"] }),
            Risk::Read,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let args: ReadArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        let workspace = self.0.workspace(key);
        let engine = self.0.bots.get();
        Box::pin(async move {
            let workspace = match workspace {
                Ok(workspace) => workspace,
                Err(output) => return output,
            };
            let path = args.path.clone();
            let read = tokio::task::spawn_blocking(move || {
                let path = workspace.normal(&path)?;
                let read = match super::reading::shape(&workspace.head(&path)?) {
                    super::reading::Shape::Image => {
                        Read::Image(workspace.bytes_up_to(&path, super::reading::LARGEST_IMAGE)?)
                    }
                    super::reading::Shape::Document => Read::Document(
                        workspace.bytes_up_to(&path, super::reading::LARGEST_DOCUMENT)?,
                    ),
                    super::reading::Shape::Text => Read::Text(workspace.text(&path)?),
                };
                let bytes = match &read {
                    Read::Text(text) => text.as_bytes(),
                    Read::Image(bytes) | Read::Document(bytes) => bytes,
                };
                let trusted = workspace.file_trusted(&path, bytes);
                Ok::<_, PathError>((path, read, trusted))
            })
            .await
            .unwrap_or_else(|_| Err(PathError::Io("the file work stopped".to_owned())));
            let (path, read, trusted) = match read {
                Ok(read) => read,
                Err(error) => return ToolOutput::error(error.to_string()),
            };
            let output = match read {
                Read::Text(text) => ToolOutput::ok(super::files::window(
                    &path,
                    &text,
                    args.offset.unwrap_or(1),
                    args.limit.unwrap_or(super::files::READ_LINES),
                )),
                Read::Image(bytes) => ToolOutput {
                    content: super::reading::image_line(&path, &bytes),
                    images: vec![bytes],
                    ..ToolOutput::ok("")
                },
                Read::Document(bytes) => match engine {
                    Some(engine) => match engine.media().attach(&path, bytes).await {
                        Ok(document) => {
                            ToolOutput::ok(spade_core::context::document_text(&document, false))
                        }
                        Err(error) => ToolOutput::error(error.to_string()),
                    },
                    None => ToolOutput::error(format!(
                        "{path} is a document, and Spade can't read documents right now."
                    )),
                },
            };
            marked(output, trusted)
        })
    }
}

pub struct WorkspaceSearch(Place);

#[derive(Deserialize)]
struct SearchArgs {
    text: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    ignore_case: bool,
    #[serde(default)]
    regex: bool,
    #[serde(default)]
    glob: Option<String>,
}

impl Tool for WorkspaceSearch {
    fn def(&self) -> ToolDef {
        def(
            "workspace_search",
            "Finds lines in your workspace's files (under path, or all) as path:line: text, 200 \
             at most. text is found as written, or read as a regular expression with regex: \
             true; glob keeps to files fitting a pattern (*.csv, src/**/*.rs).",
            json!({ "type": "object",
                    "properties": { "text": { "type": "string" },
                                    "path": { "type": "string" },
                                    "ignore_case": { "type": "boolean" },
                                    "regex": { "type": "boolean" },
                                    "glob": { "type": "string" } },
                    "required": ["text"] }),
            Risk::Read,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let args: SearchArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        let name = output_name(key);
        blocking(&self.0, key, move |workspace| {
            let needle = super::matching::Needle::new(&args.text, args.regex, args.ignore_case)
                .map_err(PathError::Io)?;
            let only = args
                .glob
                .as_deref()
                .filter(|glob| !glob.trim().is_empty())
                .map(super::matching::Glob::new)
                .transpose()
                .map_err(PathError::Io)?;
            let found = workspace.search(&args.path, &needle, only.as_ref())?;
            let start = workspace.normal(&args.path)?;
            let trusted = workspace.plain_folder(&start)
                && found.files.iter().all(|(path, hash)| {
                    workspace.plain_file(path) && workspace.trust().trusted(path, hash)
                });
            let shown = workspace.keep_large(&name, &found.text);
            Ok(marked(ToolOutput::ok(shown), trusted))
        })
    }
}

pub struct WorkspaceFind(Place);

#[derive(Deserialize)]
struct FindArgs {
    pattern: String,
    #[serde(default)]
    path: String,
}

impl Tool for WorkspaceFind {
    fn def(&self) -> ToolDef {
        def(
            "workspace_find",
            "Finds files in your workspace whose path fits a pattern: *.csv (a name, in any \
             folder), reports/**/*.pdf (a path from the top). Lists each with its size, 500 at \
             most; links are not followed.",
            json!({ "type": "object",
                    "properties": { "pattern": { "type": "string" },
                                    "path": { "type": "string" } },
                    "required": ["pattern"] }),
            Risk::Read,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let args: FindArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        blocking(&self.0, key, move |workspace| {
            let glob = super::matching::Glob::new(&args.pattern).map_err(PathError::Io)?;
            let (found, more) = workspace.find(&args.path, &glob)?;
            let start = workspace.normal(&args.path)?;
            // Names are content too: trusted only when every file named is a trusted file.
            let trusted = workspace.plain_folder(&start)
                && found.iter().all(|(path, size)| {
                    *size <= super::files::LARGEST_WRITE as u64
                        && workspace
                            .bytes_up_to(path, super::files::LARGEST_WRITE as u64)
                            .is_ok_and(|bytes| workspace.file_trusted(path, &bytes))
                });
            if found.is_empty() {
                let none = format!("No file fits {:?}.", args.pattern);
                return Ok(marked(ToolOutput::ok(none), trusted));
            }
            let mut lines: Vec<String> = found
                .iter()
                .map(|(path, size)| format!("{path} ({size} bytes)"))
                .collect();
            let count = lines.len();
            lines.insert(
                0,
                if count == 1 {
                    "1 file:".to_owned()
                } else {
                    format!("{count} files:")
                },
            );
            if more {
                lines.push(format!(
                    "[Only the first {count} shown; narrow the pattern.]"
                ));
            }
            Ok(marked(ToolOutput::ok(lines.join("\n")), trusted))
        })
    }
}

pub struct WorkspaceWrite(Place);

#[derive(Deserialize)]
struct WriteArgs {
    path: String,
    content: String,
}

impl Tool for WorkspaceWrite {
    fn def(&self) -> ToolDef {
        def(
            "workspace_write",
            "Writes a whole file in your workspace, creating its folders; replaces the file if it \
             exists.",
            json!({ "type": "object",
                    "properties": { "path": { "type": "string" },
                                    "content": { "type": "string" } },
                    "required": ["path", "content"] }),
            Risk::Write,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        self.run_in(key, arguments, &TurnFacts::default())
    }

    fn run_in(&self, key: &str, arguments: Value, turn: &TurnFacts) -> ToolFuture {
        let args: WriteArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        let untrusted = turn.untrusted.clone();
        let (place, key) = (self.0.clone(), key.to_owned());
        blocking(&self.0, &key.clone(), move |workspace| {
            let path = workspace.normal(&args.path)?;
            // Checked and written under the workspace's file lock, so the person's write can't
            // land between (ADR 0143).
            workspace.changing(|| {
                if let Some(yielded) = place.yields(&key, &path) {
                    return Ok(yielded);
                }
                workspace.before_bot_commit(&path);
                let bytes = workspace.write(&path, &args.content)?;
                workspace.trust().record_write(
                    &path,
                    args.content.as_bytes(),
                    untrusted.as_deref(),
                );
                place.files_changed(&key, Some(vec![path.clone()]));
                Ok(ToolOutput::ok(format!("Wrote {bytes} bytes to {path}.")))
            })
        })
    }
}

pub struct WorkspaceEdit(Place);

#[derive(Deserialize)]
struct EditArgs {
    path: String,
    #[serde(default)]
    old: Option<String>,
    #[serde(default)]
    new: Option<String>,
    #[serde(default)]
    replace_all: bool,
    #[serde(default)]
    edits: Option<Vec<OneEdit>>,
}

#[derive(Deserialize)]
struct OneEdit {
    old: String,
    new: String,
    #[serde(default)]
    replace_all: bool,
}

impl EditArgs {
    /// The changes the call asks for: one (`old`, `new`) or several (`edits`), never both.
    fn changes(self) -> Result<Vec<super::edits::Change>, String> {
        match (self.old, self.new, self.edits) {
            (Some(old), Some(new), None) => Ok(vec![super::edits::Change {
                old,
                new,
                all: self.replace_all,
            }]),
            (None, None, Some(edits)) => Ok(edits
                .into_iter()
                .map(|edit| super::edits::Change {
                    old: edit.old,
                    new: edit.new,
                    all: edit.replace_all,
                })
                .collect()),
            (_, _, Some(_)) => Err("give either old and new, or edits, not both".to_owned()),
            _ => Err("give old and new (or edits: a list of them)".to_owned()),
        }
    }
}

impl Tool for WorkspaceEdit {
    fn def(&self) -> ToolDef {
        def(
            "workspace_edit",
            "Changes a file in your workspace: replaces `old` with `new`. Copy `old` exactly, \
             with enough around it to appear once, or set replace_all to change every place. \
             For several changes give edits (a list of old/new) instead: they apply in order, \
             and if one can't, none do.",
            json!({ "type": "object",
                    "properties": { "path": { "type": "string" },
                                    "old": { "type": "string" },
                                    "new": { "type": "string" },
                                    "replace_all": { "type": "boolean" },
                                    "edits": { "type": "array",
                                               "items": { "type": "object",
                                                          "properties": { "old": { "type": "string" },
                                                                          "new": { "type": "string" },
                                                                          "replace_all": { "type": "boolean" } },
                                                          "required": ["old", "new"] } } },
                    "required": ["path"] }),
            Risk::Write,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        self.run_in(key, arguments, &TurnFacts::default())
    }

    fn run_in(&self, key: &str, arguments: Value, turn: &TurnFacts) -> ToolFuture {
        let args: EditArgs = match parse(arguments) {
            Ok(args) => args,
            Err(output) => return Box::pin(async move { output }),
        };
        let path = args.path.clone();
        let changes = match args.changes() {
            Ok(changes) => changes,
            Err(why) => return Box::pin(async move { ToolOutput::error(why) }),
        };
        let untrusted = turn.untrusted.clone();
        let (place, key) = (self.0.clone(), key.to_owned());
        blocking(&self.0, &key.clone(), move |workspace| {
            let path = workspace.normal(&path)?;
            workspace.changing(|| {
                if let Some(yielded) = place.yields(&key, &path) {
                    return Ok(yielded);
                }
                workspace.before_bot_commit(&path);
                let (before, after, places) = workspace.edit(&path, &changes)?;
                workspace.trust().record_edit(
                    &path,
                    before.as_bytes(),
                    after.as_bytes(),
                    untrusted.as_deref(),
                );
                place.files_changed(&key, Some(vec![path.clone()]));
                Ok(ToolOutput::ok(if places == 1 {
                    format!("Changed {path}.")
                } else {
                    format!("Changed {path} in {places} places.")
                }))
            })
        })
    }
}
