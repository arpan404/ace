// SPDX-License-Identifier: Apache-2.0
//! The generated static table. `build.rs` writes it from `native/cli/table.json`.

use crate::types::{
    AliasSpec, ArgSpec, CommandSpec, Example, ExitCodeMeaning, ExitSpec, FlagSpec, Group, NounSpec,
    PersonOnly, RefKind, TopicSpec,
};

include!(concat!(env!("OUT_DIR"), "/table_data.rs"));
