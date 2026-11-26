// SPDX-License-Identifier: Apache-2.0
//! Refusals (`permissions.ts:283`-`:330`): why a child's access was refused, with the modes the
//! target would accept, and the narrow that throws `AccessError`. The ceiling walk is
//! `access/ceiling.rs`.

use ace_json::Value;

use crate::access::AccessError;
use crate::access::modes::{
    AccessSelection, Identity, Policy, allowed_child_modes, inherited_permission_mode,
    permission_within_ceiling,
};
use crate::{EngineError, EngineStore, State};

/// Why a child's access was refused, with the modes the target would accept (`CeilingRefusal`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CeilingRefusal {
    pub provider: String,
    pub mode: Option<AccessSelection>,
    pub allowed: Vec<String>,
    /// The request is broader than the parent, or the target doesn't offer it.
    pub reason: &'static str,
    pub offered: Vec<String>,
}

impl CeilingRefusal {
    pub fn to_json(&self) -> Value {
        let mut value = ace_json::Map::new();
        value.insert("provider", Value::from(self.provider.as_str()));
        value.insert(
            "mode",
            self.mode.as_deref().map_or(Value::Null, Value::from),
        );
        value.insert(
            "allowed",
            Value::Array(
                self.allowed
                    .iter()
                    .map(|mode| Value::from(mode.as_str()))
                    .collect::<Vec<_>>()
                    .into(),
            ),
        );
        value.insert("reason", Value::from(self.reason));
        value.insert(
            "offered",
            Value::Array(
                self.offered
                    .iter()
                    .map(|mode| Value::from(mode.as_str()))
                    .collect::<Vec<_>>()
                    .into(),
            ),
        );
        Value::Object(value)
    }
}

impl State {
    pub fn permission_refusal(
        &mut self,
        store: &EngineStore,
        parent: &str,
        identity: &Identity,
        offers: &[crate::access::Offer],
        requested: Option<&str>,
    ) -> Option<CeilingRefusal> {
        let _ = identity;
        let ceiling = self.permission_ceiling(store, parent, 0).ok()?;
        let allowed = allowed_child_modes(&ceiling, offers);
        let offered: Vec<String> = offers.iter().map(|offer| offer.mode.clone()).collect();
        let reason = match requested {
            Some(requested)
                if requested != "inherit" && !offered.iter().any(|o| o == requested) =>
            {
                "access_unavailable"
            }
            Some(requested) if requested != "inherit" => "access_escalation_denied",
            _ => "permission_ceiling_unverifiable",
        };
        Some(CeilingRefusal {
            provider: ceiling.identity.provider,
            mode: ceiling.mode,
            allowed,
            reason,
            offered,
        })
    }

    /// `Permissions.narrow`: a child's access under `parent`.
    pub fn permission_narrow(
        &mut self,
        store: &EngineStore,
        parent: &str,
        identity: &Identity,
        requested: Option<&str>,
        offers: &[crate::access::Offer],
    ) -> Result<Option<AccessSelection>, EngineError> {
        let ceiling = self.permission_ceiling(store, parent, 0)?;
        let requested = match requested {
            None | Some("inherit") => {
                let inherited = inherited_permission_mode(&ceiling, identity, offers);
                match inherited {
                    None => {
                        return Err(AccessError::new(
                            "permission_ceiling_unverifiable",
                            "no offered mode fits",
                        )
                        .into());
                    }
                    Some(mode) => return Ok(mode),
                }
            }
            Some(requested) => requested,
        };
        if !offers.iter().any(|offer| offer.mode == requested) {
            return Err(AccessError::new(
                "access_unavailable",
                format!("{} doesn't offer {requested}", identity.provider),
            )
            .into());
        }
        if !permission_within_ceiling(&ceiling, &Policy::new(identity.clone(), Some(requested))) {
            return Err(AccessError::new(
                "access_escalation_denied",
                format!("{requested} exceeds the parent"),
            )
            .into());
        }
        Ok(Some(requested.to_owned()))
    }
}
