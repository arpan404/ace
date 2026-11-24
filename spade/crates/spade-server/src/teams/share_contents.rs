//! Read the portable parts of a bot's setup and keep only files the privacy pass can inspect.

use std::{
    collections::BTreeMap,
    path::{Component, Path},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_core::{
    package::playbooks::ModelClass, routing::Role, template_privacy::contains_private_text,
};

use super::share_template::SkillFile;
use crate::{engine::Engine, skill_store::SkillStore, tools::SkillLibrary};

#[derive(Serialize, Deserialize, PartialEq)]
pub(crate) struct TextFile {
    pub path: String,
    pub text: String,
    pub executable: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SurfaceDraft {
    definition: Value,
    text: String,
}

pub(super) fn surfaces(proposed: Vec<SurfaceDraft>) -> Result<(Vec<Value>, Vec<TextFile>), String> {
    if proposed.len() > 16 {
        return Err("Choose at most 16 surfaces.".to_owned());
    }
    let mut definitions = Vec::new();
    let mut files = Vec::new();
    for SurfaceDraft { definition, text } in proposed {
        let Some(path) = definition["file"].as_str() else {
            return Err("Each surface needs its package file.".to_owned());
        };
        if files.iter().any(|file: &TextFile| file.path == path) {
            return Err("Each surface needs its own package file.".to_owned());
        }
        files.push(TextFile {
            path: path.to_owned(),
            text,
            executable: false,
        });
        definitions.push(definition);
    }
    Ok((definitions, files))
}

pub(super) fn owned_panels(engine: &Engine, bot: &str) -> Vec<SurfaceDraft> {
    let Some(link) = engine.bot_package(bot) else {
        return Vec::new();
    };
    let hashes = crate::packages::panels::hashes(engine, bot);
    spade_core::package::surfaces::panels(&link.manifest.surfaces)
        .filter_map(|panel| {
            let mut definition = serde_json::to_value(panel).ok()?;
            let fields = definition.as_object_mut()?;
            fields.remove("hash");
            fields.insert("kind".to_owned(), json!("panel"));
            let text = crate::packages::panels::page(engine, hashes.get(&panel.id)?)?;
            Some(SurfaceDraft { definition, text })
        })
        .collect()
}

pub(super) async fn skill(
    store: &SkillStore,
    id: &str,
    reference: String,
    private: &[String],
) -> Result<SkillFile, String> {
    let refused =
        || "A requested skill stayed here because its files couldn't be shared safely.".to_owned();
    let text = store.read(id).await.map_err(|_| refused())?;
    if contains_private_text(&json!([&reference, &text]), private) {
        return Err(refused());
    }
    let mut files = Vec::new();
    let mut total = text.len();
    for file in store.files(id).await.map_err(|_| refused())? {
        let path = file.path;
        if Path::new(&path).components().any(|part| {
            !matches!(part, Component::Normal(name) if !name.to_string_lossy().starts_with('.'))
        }) || path.contains('\\') {
            return Err(refused());
        }
        let file_text = String::from_utf8(file.bytes).map_err(|_| refused())?;
        total += file_text.len();
        if total > 512 * 1024
            || file_text.contains('\0')
            || contains_private_text(&json!([&path, &file_text]), private)
        {
            return Err(refused());
        }
        files.push(TextFile {
            path,
            text: file_text,
            executable: file.executable,
        });
    }
    Ok(SkillFile {
        reference,
        text,
        files,
    })
}

pub(super) fn model_roles(
    engine: &Engine,
    bot: &str,
) -> Result<BTreeMap<String, ModelClass>, String> {
    let view = engine.agent_roles_view(bot).map_err(|e| e.to_string())?;
    let fast = engine.fast_endpoint_model();
    Ok(view
        .as_ref()
        .and_then(|view| view["roles"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let role = Role::parse(row["role"].as_str()?)?;
            let model = row["model"].as_str()?;
            if !role.routed() || model.is_empty() {
                return None;
            }
            let class = if fast.as_deref() == Some(model) {
                ModelClass::Fast
            } else {
                ModelClass::Capable
            };
            Some((role.name().to_owned(), class))
        })
        .collect())
}

pub(super) fn plugin_commands(
    engine: &Engine,
    bot: &str,
    plugins: &[String],
) -> BTreeMap<String, Vec<String>> {
    engine
        .plugins()
        .into_iter()
        .flat_map(|manager| manager.view(bot).plugins)
        .filter_map(|plugin| {
            let name = format!("spade-plugin/{}", plugin.name);
            (plugins.contains(&name) && !plugin.commands.is_empty())
                .then_some((name, plugin.commands))
        })
        .collect()
}
