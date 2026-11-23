// SPDX-License-Identifier: Apache-2.0
//! The JSON shape `native/cli/table.json` is written in.

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Table {
    #[serde(default)]
    pub(crate) global_flags: Vec<FlagJson>,
    #[serde(default)]
    pub(crate) commands: Vec<CommandJson>,
    #[serde(default)]
    pub(crate) nouns: Vec<NounJson>,
    #[serde(default)]
    pub(crate) topics: Vec<TopicJson>,
    #[serde(default)]
    pub(crate) exit_codes: Vec<ExitCodeJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlagJson {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) short: Option<String>,
    #[serde(default)]
    pub(crate) value: Option<String>,
    pub(crate) summary: String,
    #[serde(default)]
    pub(crate) repeat: bool,
    #[serde(default)]
    pub(crate) choices: Vec<String>,
    #[serde(default, rename = "ref")]
    pub(crate) reference: Option<String>,
    #[serde(default)]
    pub(crate) hidden: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArgJson {
    pub(crate) name: String,
    pub(crate) summary: String,
    #[serde(default)]
    pub(crate) required: bool,
    #[serde(default)]
    pub(crate) variadic: bool,
    #[serde(default)]
    pub(crate) stdin: bool,
    #[serde(default, rename = "ref")]
    pub(crate) reference: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AliasJson {
    pub(crate) words: Vec<String>,
    #[serde(default)]
    pub(crate) deprecated_since: Option<String>,
    #[serde(default)]
    pub(crate) insert_words: Vec<String>,
    #[serde(default)]
    pub(crate) words_as: Vec<String>,
    #[serde(default)]
    pub(crate) rename_flags: Vec<(String, String)>,
    #[serde(default)]
    pub(crate) set_flags: Vec<String>,
    #[serde(default)]
    pub(crate) by_flag: Vec<(String, String)>,
    #[serde(default)]
    pub(crate) quiet: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExampleJson {
    pub(crate) command: String,
    pub(crate) summary: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExitJson {
    pub(crate) code: u16,
    pub(crate) when: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandJson {
    pub(crate) id: String,
    pub(crate) words: Vec<String>,
    pub(crate) summary: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    pub(crate) group: String,
    #[serde(default)]
    pub(crate) args: Vec<ArgJson>,
    #[serde(default)]
    pub(crate) flags: Vec<FlagJson>,
    #[serde(default)]
    pub(crate) examples: Vec<ExampleJson>,
    #[serde(default)]
    pub(crate) aliases: Vec<AliasJson>,
    #[serde(default)]
    pub(crate) exits: Vec<ExitJson>,
    #[serde(default)]
    pub(crate) see_also: Vec<String>,
    #[serde(default)]
    pub(crate) output: Option<String>,
    #[serde(default)]
    pub(crate) mutates: bool,
    #[serde(default)]
    pub(crate) offline: bool,
    #[serde(default)]
    pub(crate) hidden: bool,
    #[serde(default)]
    pub(crate) noun_default: bool,
    #[serde(default)]
    pub(crate) person_only: Option<String>,
    #[serde(default)]
    pub(crate) passthrough: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NounJson {
    pub(crate) name: String,
    pub(crate) summary: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    pub(crate) group: String,
    #[serde(default)]
    pub(crate) hidden: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TopicJson {
    pub(crate) name: String,
    pub(crate) summary: String,
    pub(crate) text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExitCodeJson {
    pub(crate) code: u8,
    pub(crate) name: String,
    pub(crate) means: String,
}
