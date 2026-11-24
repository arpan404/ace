//! A portable draft built from the bot's proposals and the recipe's allowlisted metadata.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_core::template_privacy::contains_private_text;
use spade_store::{HEARTBEAT, Notes, ROUTINE};

use super::package_draft::owned_bot;
use super::recipe_export::{connector_needs, face_of, market_skills, model_of};
use crate::engine::Engine;
use crate::skill_store::SkillStore;
use crate::tools::SkillLibrary;

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
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Schedule {
    name: String,
    instruction: String,
    schedule: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct SkillFile {
    pub reference: String,
    pub text: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Draft {
    pub recipe: Value,
    pub skills: Vec<SkillFile>,
    pub left_out: Vec<String>,
    pub bot: String,
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
            Value::Object(fields) => fields.values().for_each(|value| strings(value, out)),
            Value::Array(items) => items.iter().for_each(|value| strings(value, out)),
            _ => {}
        }
    }

    let mut out = Vec::new();
    strings(&draft.recipe, &mut out);
    for skill in &draft.skills {
        split(&skill.reference, &mut out);
        split(&skill.text, &mut out);
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
    bot: &str,
    connectors: Option<&spade_connect::Connectors>,
    names: &[String],
) -> Result<Vec<String>, String> {
    let mut words = names.to_vec();
    let agent = engine.store().agent(bot).map_err(|e| e.to_string())?;
    if let Some(agent) = agent {
        words.push(agent.model);
    }
    for scope in [Notes::Own(bot), Notes::Shared] {
        words.extend(
            engine
                .store()
                .notes(scope)
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|note| note.text),
        );
    }
    if let Some(hub) = connectors {
        for custom in hub.list().into_iter().filter(|app| app.catalogue.is_none()) {
            words.extend([custom.id, custom.name, custom.url]);
        }
    }
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
    if proposal.skills.len() > 32 || proposal.routines.len() > 32 {
        return Err("Choose at most 32 skills and 32 routines.".to_owned());
    }
    let private = private_words(engine, bot, connectors, names)?;
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
    if !engine
        .store()
        .routines_of(bot, HEARTBEAT)
        .map_err(|e| e.to_string())?
        .is_empty()
    {
        left_out.push("Its heartbeat stays with the original bot.".to_owned());
    }

    let available = market_skills(skills, bot).map_err(|e| e.to_string())?;
    let views = skills
        .map(SkillStore::views)
        .transpose()?
        .unwrap_or_default();
    let mut references = Vec::new();
    let mut files = Vec::new();
    for requested in proposal.skills {
        let reference = format!("spade-skill/{requested}");
        if available.contains(&reference) {
            if !references.contains(&reference) {
                references.push(reference);
            }
            continue;
        }
        let Some((store, view)) = skills.zip(
            views
                .iter()
                .find(|view| view.origin == "spade" && view.name == requested),
        ) else {
            left_out.push(
                "A requested skill wasn't a Store skill used here or a skill written in Spade."
                    .to_owned(),
            );
            continue;
        };
        let reference = format!("skills/{}", view.name);
        if references.contains(&reference) {
            continue;
        }
        let text = store.read(&view.id).await?;
        if view.files != 0 {
            left_out
                .push("A skill's extra files stay here. Its instructions are included.".to_owned());
        }
        if text.len() > 16_000 || contains_private_text(&json!([&reference, &text]), &private) {
            left_out.push(
                "A skill's instructions were too large or contained private text.".to_owned(),
            );
            continue;
        }
        references.push(reference.clone());
        files.push(SkillFile { reference, text });
    }

    let face = face_of(&agent, &mut left_out);
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
        "skills": references,
        "needs": {"connectors": needs},
        "effects": [],
        "pricing": {"kind": "free"},
    });
    if let Some(face) = face {
        recipe["face"] = face;
    }
    if !engine
        .plugins()
        .map(|p| p.allowed(bot))
        .unwrap_or_default()
        .is_empty()
    {
        left_out.push("Installed plugins stay with the original bot.".to_owned());
    }
    check(&recipe, &private)?;
    left_out.sort();
    left_out.dedup();
    Ok(Draft {
        recipe,
        skills: files,
        left_out,
        bot: bot.to_owned(),
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
