//! A package with its own code (ADR 0203), for the code tests: a component written as text, so
//! the tests carry no binary, run on a real worker (Spade's own binary with `--code-worker`)
//! inside the bot's sandbox where this machine holds one offline. Its toolbox's `call` does what
//! the tool's name begins with:
//!
//! - `echo`: answers its input;
//! - `spin`: loops forever without yielding;
//! - `ask_<tool>`: calls Spade's `<tool>` with its input, and answers what Spade said;
//! - `http_get` (built with `http`): sends a GET to the URL its input names, written exactly
//!   `{"u":"<url>"}`, and answers the body.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use spade_server::code::{Code, Launch};
use spade_server::tools::{EngineHandle, Tool, Toolbox};
use spade_testkit::{FakeProvider, Script};

use super::{Options, Result, Spade};

pub const PROGRAM: &str = env!("CARGO_BIN_EXE_spade");

const TOOLS: &str = r#"[{"name":"echo","summary":"Says it back."},{"name":"spin","summary":"Never ends."},{"name":"ask_send_message","summary":"Sends through Spade."},{"name":"ask_memory_search","summary":"Searches notes."}"#;
const HTTP_TOOL: &str = r#",{"name":"http_get","summary":"Fetches a URL."}"#;

/// The component; with `http`, it also imports `spade:package/http` and has `http_get`.
pub fn component(http: bool) -> Vec<u8> {
    let list = format!("{TOOLS}{}]", if http { HTTP_TOOL } else { "" });
    let tools_len = list.len();
    let tools = list.replace('"', "\\\"");
    let http_import = if http {
        r#"
  (import "spade:package/http@1.0.0" (instance $http
    (type $header (record (field "name" string) (field "value" string)))
    (export "header" (type $header-t (eq $header)))
    (type $request (record (field "method" string) (field "url" string) (field "headers" (list $header-t)) (field "body" (list u8))))
    (export "request" (type $request-t (eq $request)))
    (type $response (record (field "status" u16) (field "headers" (list $header-t)) (field "body" (list u8))))
    (export "response" (type $response-t (eq $response)))
    (type $send-t (func (param "req" $request-t) (result (result $response-t (error string)))))
    (export "send" (func (type $send-t)))
  ))"#
    } else {
        ""
    };
    let http_lower = if http {
        r#"
  (alias export $http "send" (func $http-send))
  (core func $http-send-low (canon lower (func $http-send) (memory $memory) (realloc $realloc)))"#
    } else {
        ""
    };
    let http_core_import = if http {
        r#"(import "env" "http-send" (func $http-send (param i32 i32 i32 i32 i32 i32 i32 i32 i32)))"#
    } else {
        ""
    };
    let http_branch = if http {
        r#"
      (if (i32.eq (local.get $op) (i32.const 104)) (then
        (call $http-send (i32.const 2900) (i32.const 3)
          (i32.add (local.get $in) (i32.const 6)) (i32.sub (local.get $in_len) (i32.const 8))
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 3400))
        (if (i32.eqz (i32.load8_u (i32.const 3400)))
          (then
            (i32.store8 (i32.const 3100) (i32.const 0))
            (i32.store (i32.const 3104) (i32.load (i32.const 3416)))
            (i32.store (i32.const 3108) (i32.load (i32.const 3420))))
          (else
            (i32.store8 (i32.const 3100) (i32.const 1))
            (i32.store (i32.const 3104) (i32.load (i32.const 3404)))
            (i32.store (i32.const 3108) (i32.load (i32.const 3408)))))
        (return (i32.const 3100))))"#
    } else {
        ""
    };
    let http_with = if http {
        r#"(export "http-send" (func $http-send-low))"#
    } else {
        ""
    };
    let text = format!(
        r#"
(component
  (import "spade:package/tools@1.0.0" (instance $tools
    (export "call" (func (param "name" string) (param "input" string) (result (result string (error string)))))
  )){http_import}
  (core module $Mem
    (memory (export "memory") 1)
    (global $bump (mut i32) (i32.const 8192))
    (func (export "realloc") (param $old i32) (param $old_size i32) (param $align i32) (param $size i32) (result i32)
      (local $ptr i32)
      (local.set $ptr
        (i32.and
          (i32.add (global.get $bump) (i32.sub (local.get $align) (i32.const 1)))
          (i32.sub (i32.const 0) (local.get $align))))
      (global.set $bump (i32.add (local.get $ptr) (local.get $size)))
      (block $done
        (loop $more
          (br_if $done (i32.le_u (global.get $bump) (i32.mul (memory.size) (i32.const 65536))))
          (if (i32.eq (memory.grow (i32.const 1)) (i32.const -1)) (then unreachable))
          (br $more)))
      (if (local.get $old_size)
        (then (memory.copy (local.get $ptr) (local.get $old) (local.get $old_size))))
      (local.get $ptr)))
  (core instance $mem (instantiate $Mem))
  (alias core export $mem "memory" (core memory $memory))
  (alias core export $mem "realloc" (core func $realloc))
  (alias export $tools "call" (func $tools-call))
  (core func $tools-call-low (canon lower (func $tools-call) (memory $memory) (realloc $realloc))){http_lower}
  (core module $Main
    (import "env" "memory" (memory 1))
    (import "env" "tools-call" (func $tools-call (param i32 i32 i32 i32 i32)))
    {http_core_import}
    (data (i32.const 1024) "{tools}")
    (data (i32.const 2900) "GET")
    (func (export "tools") (result i32)
      (i32.store (i32.const 3000) (i32.const 1024))
      (i32.store (i32.const 3004) (i32.const {tools_len}))
      (i32.const 3000))
    (func (export "call") (param $name i32) (param $name_len i32) (param $in i32) (param $in_len i32) (result i32)
      (local $op i32)
      (local.set $op (i32.load8_u (local.get $name)))
      (if (i32.eq (local.get $op) (i32.const 101)) (then
        (i32.store8 (i32.const 3100) (i32.const 0))
        (i32.store (i32.const 3104) (local.get $in))
        (i32.store (i32.const 3108) (local.get $in_len))
        (return (i32.const 3100))))
      (if (i32.eq (local.get $op) (i32.const 115)) (then
        (loop $forever (br $forever))))
      (if (i32.eq (local.get $op) (i32.const 97)) (then
        (call $tools-call
          (i32.add (local.get $name) (i32.const 4)) (i32.sub (local.get $name_len) (i32.const 4))
          (local.get $in) (local.get $in_len) (i32.const 3200))
        (return (i32.const 3200)))){http_branch}
      unreachable))
  (core instance $main (instantiate $Main
    (with "env" (instance
      (export "memory" (memory $memory))
      (export "tools-call" (func $tools-call-low))
      {http_with}))))
  (func $call (param "name" string) (param "input" string) (result (result string (error string)))
    (canon lift (core func $main "call") (memory $memory) (realloc $realloc)))
  (func $list (result string)
    (canon lift (core func $main "tools") (memory $memory)))
  (instance $box
    (export "call" (func $call))
    (export "tools" (func $list)))
  (export "spade:package/toolbox@1.0.0" (instance $box)))
"#
    );
    wat::parse_str(&text).unwrap_or_else(|e| panic!("the test component: {e}"))
}

/// A `code` entry naming `code/<name>.wasm` with `imports`.
pub fn entry(name: &str, imports: &[&str]) -> Value {
    json!({
        "name": name,
        "file": format!("code/{name}.wasm"),
        "world": "spade:package/bot-tools@1.0.0",
        "imports": imports,
        "why": "Does exact work.",
        "timeout_s": 5,
    })
}

/// A version 3 package with `effects` and `code`.
pub fn recipe(effects: Value, code: Value) -> Value {
    json!({
        "format": "spade-bot",
        "version": 3,
        "requires": { "runtime": "1" },
        "name": "Fares",
        "blurb": "Picks fares.",
        "task": "Pick the cheapest fare.",
        "model": "capable",
        "triggers": [{ "kind": "message" }],
        "effects": effects,
        "code": code,
    })
}

/// Components by path, as the daemon sends them.
pub fn sent(components: &[(&str, &[u8])]) -> Value {
    Value::Object(
        components
            .iter()
            .map(|(name, bytes)| {
                (
                    format!("code/{name}.wasm"),
                    Value::String(STANDARD.encode(bytes)),
                )
            })
            .collect(),
    )
}

/// Workers inside the bot's sandbox where this machine holds one offline, else plain.
pub fn launch(spade_data: &std::path::Path) -> Launch {
    let runner = spade_sandbox::Runner::probe(Some(PROGRAM.into()));
    if cfg!(target_os = "macos") {
        assert!(runner.holds_offline(), "{:?}", runner.status());
    }
    let workers = spade_server::code::Workers {
        program: PROGRAM.into(),
        args: vec![spade_wasm::launch::WORKER_ARG.into()],
        home: spade_data.join("home"),
        spade_data: spade_data.to_path_buf(),
        ace_data: None,
    };
    if runner.holds_offline() {
        spade_server::code::sandboxed(runner, workers)
    } else {
        Arc::new(move |_folder: &std::path::Path| {
            let mut command = tokio::process::Command::new(&workers.program);
            command.args(&workers.args);
            Ok(command)
        })
    }
}

/// A Spade running package code with `http` carrying its requests, `tools` beside, and the
/// security service a package's switches need. Titles go to an endpoint of their own.
pub async fn spade(
    scripts: Vec<Script>,
    tools: Vec<Arc<dyn Tool>>,
    http: Arc<dyn spade_server::code::http::Http>,
) -> Result<(Spade, FakeProvider)> {
    let handle = EngineHandle::default();
    let toolbox = Toolbox::new(tools).with_source(Arc::new(
        spade_server::code::tools::CodeTools::new(handle.clone()),
    ));
    let spade = Spade::start_toolbox(scripts, toolbox, Options::default()).await?;
    handle.set(&spade.engine);
    super::packaged::secure(&spade).await?;
    let data = spade.dir.path().to_path_buf();
    spade
        .engine
        .set_code(Code::new(&data.join("code"), launch(&data), http));
    let titles =
        FakeProvider::start_sequence(vec![Script::reply("").plain(r#"{"title":"T"}"#)]).await?;
    let (status, body) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Titles", "format": "openai-chat", "base_url": titles.root, "needs_key": false }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    spade
        .put("/v1/settings", json!({ "fast_model": "titles/t" }))
        .await?;
    Ok((spade, titles))
}

/// Installs `recipe` with `code` as a local package, every switch in `switches`; the bot and its
/// conversation, once its components listed their tools.
pub async fn install(
    spade: &Spade,
    recipe: &Value,
    code: Value,
    switches: Value,
) -> Result<(String, String)> {
    let (status, made) = spade
        .post(
            "/v1/agents",
            json!({
                "recipe": recipe,
                "from_recipe": { "source": "local", "name": "Fares", "version": "test" },
                "grants": { "connectors": [], "plugins": [], "skills": [] },
                "switches": switches,
                "start_routines": false,
                "code": code,
            }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    let bot = made["agent"]["id"].as_str().unwrap_or_default().to_owned();
    let conversation = made["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    listed(spade, &bot).await;
    Ok((bot, conversation))
}

/// Waits until the bot's components listed their tools.
pub async fn listed(spade: &Spade, bot: &str) {
    let (Some(code), Some(link)) = (spade.engine.code(), spade.engine.bot_package(bot)) else {
        panic!("the bot has no code");
    };
    code.list(bot, &link.code).await;
}
