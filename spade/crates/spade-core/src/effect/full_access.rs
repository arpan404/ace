//! Full access skips review. Recognized sensitive commands still go to the person.

use super::{CHANGES_ACCESS, Call, DECLINED_TOOL, Place, Route, SENDS_AS_YOU, SPENDS};
use crate::autonomy::{Class, Sensitive};

pub(super) fn route(call: Call<'_>) -> Route {
    let line = match call.place {
        Place::Unsandboxed(Class::Sensitive(Sensitive::Payment)) => SPENDS,
        Place::Unsandboxed(Class::Sensitive(Sensitive::MessageAsPerson)) => SENDS_AS_YOU,
        Place::Unsandboxed(Class::Sensitive(Sensitive::Credentials)) => CHANGES_ACCESS,
        _ if call.effect.is_none() && call.remembered == Some(false) => {
            return Route::Refuse(DECLINED_TOOL.to_owned());
        }
        _ => return Route::Run,
    };
    Route::Ask {
        line: line.to_owned(),
        ask: None,
    }
}

#[cfg(test)]
mod tests;
