//! A bot made from one of Spade's own templates is linked to `spade/<id>` (ADR 0200 §3.8). When
//! this build ships a newer version of that template, it is offered to the bot as an update, the
//! same step as any package update: the person reads its plan in the update review and accepts
//! it; what the person or the bot changed stays, and anything new starts off. Nothing moves on
//! its own: the offer is only words until the person accepts exactly the version offered.

use spade_core::package::link::{Link, PackageId};
use spade_core::package::manifest::newer;

use super::PackageError;
use crate::teams::{TEMPLATE_SOURCE, TemplatePackage, package_of};

/// The shipped template version `link` may move to, if this build has a newer one than the bot.
pub fn offered(link: &Link) -> Option<&'static TemplatePackage> {
    if link.package.source != TEMPLATE_SOURCE {
        return None;
    }
    let shipped = package_of(&link.package.name)?;
    let next = &shipped.package;
    let offer = next.hash != link.package.hash
        && newer(&next.version, &link.package.version)
        && link.may_move_to(next).is_ok();
    offer.then_some(shipped)
}

/// The template version a step that claims `claimed` moves `link` to: the one this build ships,
/// and only when it is the very version offered (the person accepted what they read).
pub fn claimed(link: &Link, claimed: &PackageId) -> Result<&'static TemplatePackage, PackageError> {
    let invalid = |why: &str| PackageError::Invalid(why.to_owned());
    if link.package.source != TEMPLATE_SOURCE || claimed.name != link.package.name {
        return Err(invalid(
            "a bot moves only between versions of its own package",
        ));
    }
    let shipped = offered(link)
        .ok_or_else(|| invalid("this Spade offers no newer version of its template"))?;
    if shipped.package != *claimed {
        return Err(invalid(
            "that isn't the template version this Spade offers; look at the update again",
        ));
    }
    Ok(shipped)
}
