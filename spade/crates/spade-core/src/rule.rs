//! The rules a reader of the Spade Agent Format refuses a package by (ADR 0201 §5), each with a
//! stable id. A refusal names its rule, so a conformance case matches a refusal by id and never
//! by wording: the words are each reader's own and free to change. The table writes
//! `spade/spec/conformance/rules.json` (`SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`),
//! which the marketplace's reader (`packages/marketplace/src/rules.ts`) is held to. Pure.

use serde::Serialize;

/// A refusal: the rule it breaks and what it says, at its place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub rule: &'static str,
    pub text: String,
}

impl Problem {
    pub fn new(rule: &'static str, text: impl Into<String>) -> Self {
        Self {
            rule,
            text: text.into(),
        }
    }
}

impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text)
    }
}

/// Each problem's words, for a caller that shows them.
pub fn texts(problems: Vec<Problem>) -> Vec<String> {
    problems.into_iter().map(|p| p.text).collect()
}

/// The problems' words in one line, `between` each.
pub fn joined(problems: &[Problem], between: &str) -> String {
    problems
        .iter()
        .map(|p| p.text.as_str())
        .collect::<Vec<_>>()
        .join(between)
}

/// One rule of the spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Rule {
    pub id: &'static str,
    /// The spec part that states it.
    pub part: &'static str,
    /// What it refuses, in a sentence.
    pub says: &'static str,
    /// Whether the part's JSON Schema alone decides it, so a schema-only validator refuses it
    /// too. A rule that needs another file, the reader's build or a comparison across fields
    /// can't be written as a schema.
    pub schema: bool,
}

macro_rules! rules {
    ($($name:ident = $id:literal, $part:literal, $schema:literal, $says:literal;)+) => {
        $(pub const $name: &str = $id;)+
        /// Every rule, in the order the spec lists them.
        pub const RULES: &[Rule] = &[
            $(Rule { id: $id, part: $part, says: $says, schema: $schema },)+
        ];
    };
}

rules! {
    SECRET = "package.secret", "package", false,
        "Something in the manifest is named or shaped like a key, token or secret.";
    NOT_OBJECT = "package.not-object", "package", true, "bot.json isn't a JSON object.";
    FORMAT = "package.format", "package", true, "`format` isn't `\"spade-bot\"`.";
    VERSION = "package.version", "package", true,
        "`version` isn't the format's number this reader reads, or is a string.";
    SPEC = "package.spec", "package", true,
        "`spec` isn't a version of the Spade Agent Format this reader serves (`1.<minor>`).";
    IDENTITY = "package.identity", "package", true,
        "A field claims identity, which is the signed version manifest's alone.";
    EXECUTION = "package.execution", "package", true,
        "A field carries executions (servers, hooks, commands), which are plugins'.";
    RUNTIME_TYPE = "package.runtime-type", "package", true,
        "`requires.runtime` isn't a string.";
    RUNTIME_UNSERVED = "package.runtime-unserved", "package", true,
        "`requires.runtime` names a major version of `runtime` the reader doesn't serve.";
    SPADE_NEWER = "package.spade-newer", "package", false,
        "`requires.spade` is newer than the runtime.";
    USES = "package.uses", "package", true, "`uses` isn't a list of module names.";
    MODULE = "package.module", "package", true, "`uses` names a module the runtime lacks.";
    TRIGGERS = "package.triggers", "package", true, "`triggers` isn't a list of at most 40.";
    TRIGGER = "package.trigger", "package", false,
        "A trigger's fields aren't what its kind takes: places, a routine's name and \
         instruction, a schedule the runtime reads, an event it names.";
    ROUTINES = "package.routines", "package", false,
        "More than 32 routines, or two routines of one name.";
    PRICE = "package.price", "package", true, "Any price but free.";
    FIELD = "package.field", "package", false,
        "A field of the manifest isn't its shape, or is past its bound.";
    EFFECTS = "effects.list", "effects", true, "`effects` isn't a list of at most 32.";
    CREDENTIAL = "effects.credential", "effects", true, "The `credential` effect is declared.";
    DRIVE = "effects.drive", "effects", true,
        "`drive` is declared as an effect of its own, not as a `network` grant.";
    WORD = "effects.word", "effects", true, "An effect's word isn't an effect.";
    WHY = "effects.why", "effects", true, "An effect doesn't say why, in 1 to 500 characters.";
    HOSTS_ONLY_NETWORK = "effects.hosts-only-network", "effects", true,
        "An effect other than `network` names hosts.";
    HOSTS = "effects.hosts", "effects", false, "`hosts` isn't 1 to 32 host names.";
    HOSTS_AND_GRANT = "effects.hosts-and-grant", "effects", true,
        "An effect asks for hosts and a grant both.";
    NEVER_GRANTED = "effects.never-granted", "effects", true,
        "A grant under an effect other than `network` or `publish`, which go to the person.";
    GRANT = "effects.grant", "effects", false,
        "A grant isn't a `drive_site`, `drive_app` or `tool` grant a package may ask for.";
    PERSON_ONLY = "effects.person-only", "effects", true,
        "A grant of what is the person's alone: a push, a comment, a folder, or a tool that \
         sends in the person's name.";
    TWICE = "effects.twice", "effects", false, "An effect is declared twice.";
    CONTRACTS = "contracts.list", "contracts", true, "`contracts` isn't a list of at most 16.";
    CONTRACT_FIELD = "contracts.field", "contracts", true,
        "A contract isn't an object, or holds a field contracts don't have.";
    CONTRACT_NAME = "contracts.name", "contracts", true,
        "A contract's name isn't lower-case words joined by `_`.";
    CONTRACT_NAME_UNIQUE = "contracts.name-unique", "contracts", false,
        "Two contracts have one name.";
    SUMMARY = "contracts.summary", "contracts", true,
        "A contract doesn't say in one line of at most 200 characters what it answers.";
    CONTRACT_EFFECT = "contracts.effect", "contracts", true,
        "A contract's effects name a word a call may not use.";
    CONTRACT_EFFECT_UNDECLARED = "contracts.effect-undeclared", "contracts", false,
        "A contract's effect isn't among the package's effects.";
    EXAMPLE = "contracts.example", "contracts", false,
        "A contract's example isn't an input and output that fit its schemas.";
    CONTRACT_FILE = "contracts.file", "contracts", true,
        "A contract's schema file isn't `contracts/<name>.json`.";
    CONTRACT_FILE_MISSING = "contracts.file-missing", "contracts", false,
        "A contract's schema file isn't in the package.";
    CONTRACT_FILE_AND_INLINE = "contracts.file-and-inline", "contracts", true,
        "A contract writes its schemas both in bot.json and in a file.";
    CONTRACT_FILE_CONTENT = "contracts.file-content", "contracts", false,
        "A contract's schema file isn't a JSON object of only `input` and `output`, of at most \
         40 KiB.";
    SCHEMA_SIZE = "schema.size", "contracts", false, "A schema is longer than 16 KiB.";
    SCHEMA_OBJECT = "schema.object", "contracts", true, "A schema isn't a JSON object.";
    SCHEMA_KEYWORD = "schema.keyword", "contracts", true,
        "A schema uses a keyword outside the bounded subset.";
    SCHEMA_TEXT = "schema.text", "contracts", true,
        "A schema's `description` or `title` isn't text of at most 500 characters.";
    SCHEMA_TYPE = "schema.type", "contracts", true,
        "A schema's `type` isn't object, string, number, integer, boolean or array.";
    SCHEMA_DEPTH = "schema.depth", "contracts", false, "A schema nests more than 6 levels.";
    SCHEMA_CLOSED = "schema.closed", "contracts", true,
        "An object's `additionalProperties` isn't false.";
    SCHEMA_FIELDS = "schema.fields", "contracts", false,
        "An object names more than 64 fields, or a field name that isn't 1 to 64 letters, \
         digits and `_`.";
    SCHEMA_REQUIRED = "schema.required", "contracts", false,
        "`required` names a field the object doesn't have.";
    SCHEMA_MAX_LENGTH = "schema.max-length", "contracts", true,
        "A string doesn't say how long it may be (`maxLength`, 1 to 65,536).";
    SCHEMA_MAX_ITEMS = "schema.max-items", "contracts", true,
        "A list doesn't say how long it may be (`maxItems`, 1 to 1,000), or what it holds.";
    SCHEMA_ENUM = "schema.enum", "contracts", true,
        "An enum isn't 1 to 64 words of at most 200 characters.";
    SCHEMA_BOUND = "schema.bound", "contracts", false,
        "A bound isn't a number, or a lower bound is past its upper one.";
    SURFACES = "surfaces.list", "surfaces", true, "`surfaces` isn't a list of at most 16.";
    SURFACE_FIELD = "surfaces.field", "surfaces", true, "A surface isn't an object.";
    SURFACE_ID = "surfaces.id", "surfaces", true,
        "A surface's id isn't lower-case letters, digits and dashes.";
    SURFACE_ID_UNIQUE = "surfaces.id-unique", "surfaces", false, "Two surfaces have one id.";
    SURFACE_KIND = "surfaces.kind", "surfaces", true,
        "A surface's kind isn't `card` or `panel`.";
    CARD_FILE = "surfaces.card-file", "surfaces", true,
        "A card's file isn't `cards/<name>.json`.";
    PANEL_FILE = "surfaces.panel-file", "surfaces", false,
        "A panel's page isn't `panels/<id>/index.html`, in its own folder.";
    PANEL_TITLE = "surfaces.title", "surfaces", true,
        "A panel isn't named in a few words (`title`, at most 60 characters).";
    PANELS = "surfaces.panels", "surfaces", false, "More than 8 panels.";
    ACTIONS = "surfaces.actions", "surfaces", true,
        "A panel's `actions` isn't a list of at most 16.";
    ACTION_NAME = "surfaces.action-name", "surfaces", true,
        "An action's name isn't lower-case letters, digits and underscores.";
    ACTION_NAME_UNIQUE = "surfaces.action-name-unique", "surfaces", false,
        "Two actions of one panel have one name.";
    ACTION_LABEL = "surfaces.action-label", "surfaces", true,
        "An action's label isn't a few words (at most 40 characters).";
    CONFIRM = "surfaces.confirm", "surfaces", true, "An action's `confirm` isn't true or false.";
    CHECKS = "checks.list", "package", true, "`checks` isn't a list of at most 32.";
    CHECK_FIELD = "checks.field", "package", false,
        "A check isn't an object, or holds a field checks don't have.";
    CHECK_NAME = "checks.name", "package", false,
        "A check's name isn't 1 to 40 lower-case letters, digits and dashes.";
    CHECK_NAME_UNIQUE = "checks.name-unique", "package", false, "Two checks have one name.";
    CHECK_ON = "checks.on", "package", false,
        "A check's `on` isn't 1 to 8 places, each once: one of the package's contracts \
         (`contract:<name>`), one of its cards (`card:<id>`) or `goal`.";
    CHECK_KIND = "checks.kind", "package", false,
        "A check's kind isn't `schema`, `code` or `criterion`.";
    CHECK_CODE_LATER = "checks.code-later", "package", false,
        "A `code` check, which the runtime doesn't run yet.";
    CHECK_SCHEMA_PLACE = "checks.schema-place", "package", false,
        "A `schema` check is on the goal, or has no `rule`.";
    CHECK_CRITERION = "checks.criterion", "package", false,
        "A `criterion` check is on anything but the goal, or doesn't say in 1 to 500 characters \
         what must hold.";
    CHECK_CRITERIA = "checks.criteria", "package", false, "More than 8 `criterion` checks.";
    RULE_SIZE = "check-rule.size", "package", false, "A check's rule is longer than 16 KiB.";
    RULE_OBJECT = "check-rule.object", "package", false, "A check's rule isn't a JSON object.";
    RULE_KEYWORD = "check-rule.keyword", "package", false,
        "A check's rule uses a keyword outside the rule subset.";
    RULE_MIXED = "check-rule.mixed", "package", false,
        "A check's rule mixes keywords of different kinds of value.";
    RULE_TYPE = "check-rule.type", "package", false,
        "A check's rule names a `type` that isn't one, or one its keywords don't narrow.";
    RULE_TEXT = "check-rule.text", "package", false,
        "A check's rule's `description` or `title` isn't text of at most 500 characters.";
    RULE_DEPTH = "check-rule.depth", "package", false, "A check's rule nests more than 6 levels.";
    RULE_FIELDS = "check-rule.fields", "package", false,
        "A check's rule names more than 64 fields, or a field name that isn't 1 to 64 letters, \
         digits and `_`.";
    RULE_REQUIRED = "check-rule.required", "package", false,
        "A check's rule's `required` isn't a list of field names.";
    RULE_ENUM = "check-rule.enum", "package", false,
        "A check's rule's enum isn't 1 to 64 words of at most 200 characters.";
    RULE_BOUND = "check-rule.bound", "package", false,
        "A check's rule's bound isn't a number in its range, or a lower bound is past its upper one.";
    RULE_PATTERN = "check-rule.pattern", "package", false,
        "A check's rule's `pattern` is outside the part of regular expressions both readers \
         read alike, or longer than 200 characters.";
    CODE_LIST = "code.list", "code", true, "`code` isn't a list of at most 4 components.";
    CODE_FIELD = "code.field", "code", true, "A component's entry isn't an object.";
    CODE_NAME = "code.name", "code", true,
        "A component's name isn't 1 to 24 lower-case letters and digits, starting with a letter.";
    CODE_NAME_UNIQUE = "code.name-unique", "code", false, "Two components have one name.";
    CODE_FILE = "code.file", "code", false,
        "A component's file isn't `code/<name>.wasm`: never precompiled code, never outside `code/`.";
    CODE_WORLD = "code.world", "code", true, "A component's world isn't one of Spade's.";
    CODE_WORLD_LATER = "code.world-later", "code", false,
        "A component is built for a world of Spade's that the runtime doesn't run yet.";
    CODE_IMPORTS = "code.imports", "code", true,
        "A component's `imports` isn't a list of interface names.";
    CODE_IMPORT = "code.import", "code", true,
        "A component imports something outside Spade's world: a file system, sockets, the \
         command line, incoming HTTP, threads or any other interface.";
    CODE_IMPORT_TWICE = "code.import-twice", "code", true, "A component lists an import twice.";
    CODE_HTTP_NETWORK = "code.http-network", "code", false,
        "A component imports `spade:package/http` and the package declares no `network` effect \
         naming hosts.";
    CODE_WHY = "code.why", "code", true,
        "A component doesn't say what its code does, in 1 to 500 characters.";
    CODE_BOUND = "code.bound", "code", true,
        "A component's `timeout_s` isn't 1 to 300, or its `memory_mb` 1 to 512.";
    CODE_FILE_MISSING = "code.file-missing", "code", false,
        "A component the manifest names isn't in the package.";
    CODE_STRAY = "code.stray", "code", false,
        "A file under `code/` isn't a named component, `code/src/` or `code/build.json`.";
    CODE_BINARY = "code.binary", "code", false,
        "A component's bytes aren't a component of Spade's world: over 8 MiB, a core module, \
         precompiled code, invalid with the features a runtime enables, importing outside the \
         world, or exporting what the world doesn't.";
    CODE_BINARY_IMPORTS = "code.binary-imports", "code", false,
        "A component's binary imports differ from its entry's `imports`, either way.";
}

/// The rule of `id`.
pub fn of(id: &str) -> Option<&'static Rule> {
    RULES.iter().find(|rule| rule.id == id)
}
