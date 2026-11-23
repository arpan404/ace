// SPDX-License-Identifier: Apache-2.0
//! The interaction and background-task rows of `entities.ts`: opening and
//! closing interactions, starting and ending background work, with the refine
//! path for work announced before its spawn is known.

use serde::{Deserialize, Serialize};

use crate::emit::{Event, emit, get, put};
use crate::item_model::{RawPayload, Vetted, vet_json, vetted_json};
use crate::json_io::de_i64;
use crate::state::{ApplyContext, ThreadState};

