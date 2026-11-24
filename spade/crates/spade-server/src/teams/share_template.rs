//! A portable draft built from the bot's proposals and the recipe's allowlisted metadata.

use super::share_contents;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_core::{
    package::playbooks::{Heartbeat, Page},
    template_privacy::contains_private_text,
};
use spade_store::{HEARTBEAT, Notes, ROUTINE};

use super::package_draft::owned_bot;
use super::recipe_export::{connector_needs, face_of, model_of};
use crate::engine::Engine;
use crate::skill_store::SkillStore;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Proposal {
    name: Option<String>,
    description: String,
    task: String,
    #[serde(default)]
    notes: Vec<String>,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    routines: Vec<Schedule>,
    #[serde(default)]
    knowledge: Vec<Page>,
    heartbeat: Option<Heartbeat>,
    #[serde(default)]
    surfaces: Option<Vec<share_contents::SurfaceDraft>>,
    #[serde(default)]
    contracts: Option<Vec<Value>>,
    #[serde(default)]
    effects: Option<Vec<Value>>,
    #[serde(default)]
    event_routines: Vec<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Schedule {
    name: String,
    instruction: String,
    schedule: String,
}

#[derive(Serialize, Deserialize, PartialEq)]
pub(crate) struct SkillFile {
    pub reference: String,
    pub text: String,
    #[serde(default)]
    pub files: Vec<share_contents::TextFile>,
}

#[derive(Serialize, Deserialize, PartialEq)]
pub(crate) struct Draft {
    pub recipe: Value,
    pub skills: Vec<SkillFile>,
    pub left_out: Vec<String>,
    pub bot: String,
    #[serde(default)]
    pub surface_files: Vec<share_contents::TextFile>,
}

impl Draft {
    pub(crate) fn key(id: &str) -> String {
        format!("share-template:{id}")
    }
}

/// Bound the text arguments the daemon's privacy picker accepts, with overlap for matches that
/// straddle a chunk. Use bytes here, so each chunk fits its UTF-16 string limit as well.
pub(crate) fn privacy_text(draft: &Draft) -> Vec<&str> {
    fn split<'a>(mut text: &'a str, out: &mut Vec<&'a str>) {
        while text.len() > 8_000 {
            let end = text.floor_char_boundary(8_000);
            out.push(&text[..end]);
            text = &text[text.floor_char_boundary(end - 200)..];
        }
        out.push(text);
    }

    fn strings<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
        match value {
            Value::String(text) => split(text, out),
            Value::Object(fields) => fields.iter().for_each(|(key, value)| {
                split(key, out);
                strings(value, out);
            }),
            Value::Array(items) => items.iter().for_each(|value| strings(value, out)),
            _ => {}
        }
    }

    let mut out = Vec::new();
    strings(&draft.recipe, &mut out);
    for skill in &draft.skills {
        split(&skill.reference, &mut out);
        split(&skill.text, &mut out);
        for file in &skill.files {
            split(&file.path, &mut out);
            split(&file.text, &mut out);
        }
    }
    for file in &draft.surface_files {
        split(&file.path, &mut out);
        split(&file.text, &mut out);
    }
    out
}

pub(crate) fn system_words() -> Vec<String> {
    let words = [
        "HOME",
        "USERPROFILE",
        "USER",
        "USERNAME",
        "SPADE_PERSON_NAME",
    ]
    .into_iter()
    .filter_map(|key| std::env::var(key).ok());
    #[cfg(target_os = "macos")]
    let words = words.chain(
        std::process::Command::new("/usr/bin/id")
            .arg("-F")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned()),
    );
    words.collect()
}

pub(crate) fn private_words(
    engine: &Engine,
    bot: Option<&str>,
    connectors: Option<&spade_connect::Connectors>,
    names: &[String],
) -> Result<Vec<String>, String> {
    let mut words = names.to_vec();
    let agents = engine.store().agents().map_err(|e| e.to_string())?;
    for agent in agents
        .iter()
        .filter(|agent| bot.is_none_or(|bot| bot == agent.id || agent.kind == crate::engine::MAIN))
    {
        let owner = agent.id.as_str();
        words.push(agent.model.clone());
        if let Some(view) = engine.agent_roles_view(owner).map_err(|e| e.to_string())?
            && let Some(roles) = view["roles"].as_array()
        {
            for role in roles {
                if let Some(model) = role["model"].as_str() {
                    words.push(model.to_owned());
                }
                if let Some(route) = role["route"].as_array() {
                    words.extend(route.iter().filter_map(Value::as_str).map(str::to_owned));
                }
            }
        }
        words.extend(
            engine
                .store()
                .notes(Notes::Own(owner))
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|note| note.text),
        );
        words.extend(
            engine
                .store()
                .knowledge(owner, None)
                .map_err(|e| e.to_string())?
                .into_iter()
                .flat_map(|entry| [entry.title, entry.body]),
        );
    }
    words.extend(
        engine
            .store()
            .notes(Notes::Shared)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|note| note.text),
    );
    if let Some(hub) = connectors {
        for custom in hub.list().into_iter().filter(|app| app.catalogue.is_none()) {
            words.extend([custom.id, custom.name, custom.url]);
        }
    }
    words.sort_unstable();
    words.dedup();
    Ok(words)
}

pub(crate) async fn make(
    engine: &Engine,
    bot: &str,
    proposal: Proposal,
    connectors: Option<&spade_connect::Connectors>,
    skills: Option<&SkillStore>,
    names: &[String],
) -> Result<Draft, String> {
    let agent = owned_bot(engine, bot).map_err(|e| e.to_string())?;
    if proposal.skills.len() > 32 || proposal.routines.len() + proposal.event_routines.len() > 32 {
        return Err("Choose at most 32 skills and 32 routines.".to_owned());
    }
    let private = private_words(engine, Some(bot), connectors, names)?;
    let mut left_out = vec![
        "Conversation history, private memories, grants, credentials and the exact model stay here.".to_owned(),
    ];
    let needs = connectors
        .map(|hub| connector_needs(hub, bot, &mut left_out))
        .unwrap_or_default();
    let mut triggers = vec![json!({"kind": "message"})];
    for routine in proposal.routines {
        let mut trigger = serde_json::to_value(routine).map_err(|e| e.to_string())?;
        trigger["kind"] = json!("schedule");
        triggers.push(trigger);
    }
    for routine in proposal.event_routines {
        if !matches!(routine["kind"].as_str(), Some("event" | "webhook")) {
            return Err("Event routines use kind event or webhook.".to_owned());
        }
        let mut safe = json!({ "kind": routine["kind"], "name": routine["name"], "instruction": routine["instruction"] });
        if routine["kind"] == "event" {
            safe["event"] = routine["event"].clone();
        }
        triggers.push(safe);
    }
    let original = engine
        .store()
        .routines_of(bot, ROUTINE)
        .map_err(|e| e.to_string())?;
    if original.iter().any(|routine| {
        !triggers
            .iter()
            .any(|trigger| trigger["name"] == routine.name)
    }) {
        left_out.push("Routines you didn't choose stay with the original bot.".to_owned());
    }
    if proposal.heartbeat.is_none()
        && !engine
            .store()
            .routines_of(bot, HEARTBEAT)
            .map_err(|e| e.to_string())?
            .is_empty()
    {
        left_out.push("Its heartbeat stays with the original bot.".to_owned());
    }

    left_out.push("Personal names, places, accounts, repositories, work history, and original knowledge and episode records stay here.".to_owned());
    let views = skills
        .map(SkillStore::views)
        .transpose()?
        .unwrap_or_default();
    let mut references = Vec::new();
    let mut files = Vec::new();
    for requested in proposal.skills {
        let name = requested.strip_prefix("spade-skill/").unwrap_or(&requested);
        if let Some(view) = views
            .iter()
            .find(|view| view.origin == "market" && (view.name == name || view.id == requested))
        {
            let reference = format!("spade-skill/{}", view.name);
            if !references.contains(&reference) {
                references.push(reference);
            }
            continue;
        }
        let Some((store, view)) = skills.zip(views.iter().find(|view| {
            matches!(view.origin, "spade" | "ace")
                && (view.name == requested || view.id == requested)
        })) else {
            left_out.push(
                "A requested skill wasn't in the person's saved skills or Store library."
                    .to_owned(),
            );
            continue;
        };
        let reference = format!("skills/{}", view.name);
        if references.contains(&reference) {
            continue;
        }
        match share_contents::skill(store, &view.id, reference, &private).await {
            Ok(skill) => {
                references.push(skill.reference.clone());
                files.push(skill);
            }
            Err(why) => left_out.push(why),
        }
    }

    let face = face_of(&agent, &mut left_out);
    let owned = engine.bot_package(bot);
    let (surfaces, surface_files) = share_contents::surfaces(
        proposal
            .surfaces
            .unwrap_or_else(|| share_contents::owned_panels(engine, bot)),
    )?;
    let contracts = proposal.contracts.unwrap_or_else(|| {
        owned
            .as_ref()
            .map(|link| {
                link.manifest
                    .contracts
                    .iter()
                    .filter(|contract| contract.effects.is_empty())
                    .filter_map(|contract| serde_json::to_value(contract).ok())
                    .collect()
            })
            .unwrap_or_default()
    });
    let plugins = super::recipe_export::plugins_of(engine.plugins().map(AsRef::as_ref), bot);
    let command_needs = share_contents::plugin_commands(engine, bot, &plugins);
    let mut recipe = json!({
        "format": "spade-bot",
        "version": 3,
        "requires": {"runtime": "1"},
        "name": proposal.name.as_deref().unwrap_or(&agent.name).trim(),
        "blurb": proposal.description.trim(),
        "task": proposal.task.trim(),
        "model": model_of(engine, &agent),
        "triggers": triggers,
        "notes": proposal.notes,
        "knowledge": proposal.knowledge,
        "model_roles": share_contents::model_roles(engine, bot)?,
        "plugins": plugins,
        "plugin_commands": command_needs,
        "surfaces": surfaces,
        "contracts": contracts,
        "skills": references,
        "needs": {"connectors": needs},
        "effects": proposal.effects.unwrap_or_default(),
        "pricing": {"kind": "free"},
    });
    if let Some(face) = face {
        recipe["face"] = face;
    }
    if let Some(personality) = agent.personality {
        recipe["personality"] = json!(personality);
    }
    if let Some(accent) = engine.style_of(&agent)["accent"].as_str() {
        recipe["style"] = json!({"accent": accent});
    }
    if let Some(heartbeat) = proposal.heartbeat {
        recipe["heartbeat"] = json!(heartbeat);
    }
    if let Some(link) = owned {
        if link.manifest.surfaces.len() > surfaces.len() {
            left_out.push("Surfaces without a generalized replacement stay here.".to_owned());
        }
        if link.manifest.contracts.len() > recipe["contracts"].as_array().map_or(0, Vec::len) {
            left_out.push("Contracts without a generalized replacement stay here.".to_owned());
        }
        if !link.manifest.code.is_empty() {
            left_out.push("Compiled components stay in the original package.".to_owned());
        }
    }
    if surface_files
        .iter()
        .any(|file| contains_private_text(&json!([&file.path, &file.text]), &private))
    {
        return Err("A surface contains private text. Generalize it and try again.".to_owned());
    }
    check(&recipe, &private)?;
    left_out.sort();
    left_out.dedup();
    Ok(Draft {
        recipe,
        skills: files,
        left_out,
        bot: bot.to_owned(),
        surface_files,
    })
}

pub(crate) fn check(recipe: &Value, private: &[String]) -> Result<(), String> {
    if contains_private_text(recipe, private) {
        return Err("The proposal contains personal data, a private name or a credential. Generalize it and try again.".to_owned());
    }
    if recipe["blurb"]
        .as_str()
        .is_none_or(|text| text.trim().is_empty())
    {
        return Err("Describe what the template does.".to_owned());
    }
    crate::packages::manifest(recipe).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn check_files(draft: &Draft, private: &[String]) -> Result<(), String> {
    for text in privacy_text(draft) {
        if contains_private_text(&json!(text), private) {
            return Err("The template contains private text. Remove it before sharing.".to_owned());
        }
    }
    Ok(())
}
