//! Restore portable working defaults on a new bot using the recipient's model configuration.

use spade_core::package::{Manifest, playbooks::ModelClass};
use spade_core::routing::{Role, Route};

use super::PortableError;
use crate::{
    engine::{Engine, RolesChange},
    routines::{self, HeartbeatInput},
};

pub(super) fn furnish(
    engine: &Engine,
    id: &str,
    recipe: &Manifest,
    time_zone: Option<String>,
) -> Result<(), PortableError> {
    let failed = |message: String| PortableError::Invalid(message);
    let roles = recipe
        .model_roles
        .iter()
        .filter_map(|(name, class)| {
            let role = Role::parse(name)?;
            let model = match class {
                ModelClass::Fast => engine
                    .fast_endpoint_model()
                    .filter(|model| !role.needs_tools() || engine.model_usable(model)),
                ModelClass::Capable => None,
            }
            .unwrap_or_else(|| engine.new_bot_default());
            (!model.is_empty()).then(|| (name.clone(), Some(Route(vec![model]))))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    if !roles.is_empty() {
        engine
            .set_agent_roles(
                id,
                RolesChange {
                    roles,
                    ..Default::default()
                },
            )
            .map_err(|why| failed(format!("the model roles weren't set: {why}")))?;
    }
    for page in &recipe.knowledge {
        engine
            .add_package_page(id, page)
            .map_err(|why| failed(format!("starting knowledge wasn't kept: {why}")))?;
    }
    if let Some(heartbeat) = &recipe.heartbeat {
        routines::set_heartbeat(
            engine,
            id,
            HeartbeatInput {
                enabled: Some(false),
                every_minutes: Some(heartbeat.every_minutes),
                checklist: Some(heartbeat.checklist.clone()),
                time_zone,
                ..Default::default()
            },
        )
        .map_err(|why| failed(format!("the heartbeat wasn't added: {why}")))?;
    }
    Ok(())
}
