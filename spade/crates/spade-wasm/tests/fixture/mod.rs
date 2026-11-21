//! A component built for Spade's `bot-tools` world, written as text so the tests carry no binary.
//! Its toolbox's `call` does what the tool's name begins with:
//!
//! - `echo`: answers its input;
//! - `fail`: fails with its input as the reason;
//! - `spin`: loops forever without yielding;
//! - `grow`: grows its memory forever;
//! - `ask`: calls Spade's tool named by its input, with its input, and answers what Spade said;
//! - `big`: answers 17 MiB of `a`, more than the pipe carries.
//!
//! `tools` answers a JSON list of one tool.

pub const TOOLS_JSON: &str =
    r#"[{"name":"echo","summary":"Says it back.","input_schema":{},"output_schema":{}}]"#;

pub fn component() -> Vec<u8> {
    let tools = TOOLS_JSON.replace('"', "\\\"");
    let tools_len = TOOLS_JSON.len();
    let text = format!(
        r#"
(component
  (import "spade:package/tools@1.0.0" (instance $tools
    (export "call" (func (param "name" string) (param "input" string) (result (result string (error string)))))
  ))
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
  (core func $tools-call-low (canon lower (func $tools-call) (memory $memory) (realloc $realloc)))
  (core module $Main
    (import "env" "memory" (memory 1))
    (import "env" "tools-call" (func $tools-call (param i32 i32 i32 i32 i32)))
    (data (i32.const 1024) "{tools}")
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
      (if (i32.eq (local.get $op) (i32.const 102)) (then
        (i32.store8 (i32.const 3100) (i32.const 1))
        (i32.store (i32.const 3104) (local.get $in))
        (i32.store (i32.const 3108) (local.get $in_len))
        (return (i32.const 3100))))
      (if (i32.eq (local.get $op) (i32.const 115)) (then
        (loop $forever (br $forever))))
      (if (i32.eq (local.get $op) (i32.const 103)) (then
        (loop $forever (drop (memory.grow (i32.const 16))) (br $forever))))
      (if (i32.eq (local.get $op) (i32.const 98)) (then
        (local.set $op (i32.mul (memory.grow (i32.const 272)) (i32.const 65536)))
        (memory.fill (local.get $op) (i32.const 97) (i32.const 17825792))
        (i32.store8 (i32.const 3100) (i32.const 0))
        (i32.store (i32.const 3104) (local.get $op))
        (i32.store (i32.const 3108) (i32.const 17825792))
        (return (i32.const 3100))))
      (if (i32.eq (local.get $op) (i32.const 97)) (then
        (call $tools-call (local.get $in) (local.get $in_len) (local.get $in) (local.get $in_len) (i32.const 3200))
        (return (i32.const 3200))))
      unreachable))
  (core instance $main (instantiate $Main
    (with "env" (instance
      (export "memory" (memory $memory))
      (export "tools-call" (func $tools-call-low))))))
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
    wat::parse_str(&text).unwrap_or_else(|e| panic!("the fixture component: {e}"))
}

/// A component with two linear memories, one per core instance, whose `call` grows each by
/// 1,100 pages (about 69 MiB): under a 128 MiB bound alone, over it together.
pub fn two_memories() -> Vec<u8> {
    let text = r#"
(component
  (core module $Mem
    (memory (export "memory") 1)
    (func (export "realloc") (param i32 i32 i32 i32) (result i32) (i32.const 8192)))
  (core instance $mem (instantiate $Mem))
  (alias core export $mem "memory" (core memory $memory))
  (alias core export $mem "realloc" (core func $realloc))
  (core module $Other
    (memory (export "memory") 1)
    (func (export "grow") (drop (memory.grow (i32.const 1100)))))
  (core instance $other (instantiate $Other))
  (alias core export $other "grow" (core func $grow-other))
  (core module $Main
    (import "env" "memory" (memory 1))
    (import "env" "grow-other" (func $grow-other))
    (data (i32.const 1024) "[]")
    (func (export "tools") (result i32)
      (i32.store (i32.const 3000) (i32.const 1024))
      (i32.store (i32.const 3004) (i32.const 2))
      (i32.const 3000))
    (func (export "call") (param i32 i32 i32 i32) (result i32)
      (drop (memory.grow (i32.const 1100)))
      (call $grow-other)
      (i32.store8 (i32.const 3100) (i32.const 0))
      (i32.store (i32.const 3104) (local.get 2))
      (i32.store (i32.const 3108) (local.get 3))
      (i32.const 3100)))
  (core instance $main (instantiate $Main
    (with "env" (instance
      (export "memory" (memory $memory))
      (export "grow-other" (func $grow-other))))))
  (func $call (param "name" string) (param "input" string) (result (result string (error string)))
    (canon lift (core func $main "call") (memory $memory) (realloc $realloc)))
  (func $list (result string)
    (canon lift (core func $main "tools") (memory $memory)))
  (instance $box
    (export "call" (func $call))
    (export "tools" (func $list)))
  (export "spade:package/toolbox@1.0.0" (instance $box)))
"#;
    wat::parse_str(text).unwrap_or_else(|e| panic!("the two-memory component: {e}"))
}
