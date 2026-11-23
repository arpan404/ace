//! Legacy (file-based) login keychain items with an explicit access list, through the Security
//! framework. The data-protection keychain would need a `keychain-access-groups` entitlement,
//! which a Developer ID command-line binary can only carry with an embedded provisioning profile
//! (ADR 0119 amendment 2), so Spade stays on the login keychain and sets the access list itself.

use std::ffi::c_char;
use std::fmt;

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType, ToVoid};
use core_foundation::data::CFData;
use core_foundation::dictionary::CFMutableDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::array::CFArrayRef;
use core_foundation_sys::base::{CFTypeRef, OSStatus};
use core_foundation_sys::string::CFStringRef;
use security_framework::item::{
    ItemAddOptions, ItemAddValue, ItemClass, ItemSearchOptions, Limit, Location,
};
use security_framework::os::macos::access::SecAccess;
use security_framework::os::macos::code_signing::{Flags, SecCode, SecRequirement};
use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};
use security_framework_sys::base::SecAccessRef;

/// `errSecItemNotFound`.
const ITEM_NOT_FOUND: OSStatus = -25300;

/// The `kSecAttrComment` key in a search result's attributes.
const COMMENT_KEY: &str = "icmt";

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    /// `path` NULL names the calling code. For signed code the entry records its designated
    /// requirement, which later code is checked against.
    fn SecTrustedApplicationCreateFromPath(path: *const c_char, app: *mut CFTypeRef) -> OSStatus;
    fn SecAccessCreate(
        descriptor: CFStringRef,
        trustedlist: CFArrayRef,
        access: *mut SecAccessRef,
    ) -> OSStatus;
    fn SecItemAdd(
        attributes: core_foundation_sys::dictionary::CFDictionaryRef,
        result: *mut CFTypeRef,
    ) -> OSStatus;
    static kSecAttrAccess: CFStringRef;
}

/// A Security framework failure: its status code and the system's one-line description. Never
/// carries secret data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: i32,
    pub message: String,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (OSStatus {})", self.message, self.code)
    }
}

impl std::error::Error for Error {}

impl From<security_framework::base::Error> for Error {
    fn from(error: security_framework::base::Error) -> Self {
        Self {
            code: error.code(),
            message: error
                .message()
                .unwrap_or_else(|| "keychain error".to_owned()),
        }
    }
}

fn status(code: OSStatus) -> Result<(), Error> {
    if code == 0 {
        Ok(())
    } else {
        Err(security_framework::base::Error::from_code(code).into())
    }
}

/// Whether the running program's code signature satisfies `requirement` (the code-signing
/// requirement language). Unsigned, ad-hoc or otherwise signed code, and a requirement that
/// doesn't parse, all answer no.
pub fn running_code_satisfies(requirement: &str) -> bool {
    let Ok(requirement) = requirement.parse::<SecRequirement>() else {
        return false;
    };
    SecCode::for_self(Flags::NONE)
        .and_then(|code| code.check_validity(Flags::NONE, &requirement))
        .is_ok()
}

/// A generic-password item's names.
#[derive(Debug, Clone, Copy)]
pub struct Item<'a> {
    pub service: &'a str,
    pub account: &'a str,
    /// The name keychain dialogs and Keychain Access show.
    pub label: &'a str,
    /// Spade's mark that it created the item with its own access list.
    pub comment: &'a str,
}

/// Replaces `item`'s secret with `secret`, in a new item whose access list trusts the running
/// program by its designated requirement. The old item, if any, is deleted first: an existing
/// item's access list can't be changed without its owner's consent, and a new one is filed with
/// the access Spade chooses.
pub fn replace_owned(item: &Item<'_>, secret: &[u8]) -> Result<(), Error> {
    let keychain = login()?;
    match search(&keychain, item.service, item.account).delete() {
        Ok(()) => {}
        Err(error) if error.code() == ITEM_NOT_FOUND => {}
        Err(error) => return Err(error.into()),
    }
    add_owned(&keychain, item, secret)
}

/// `item`'s comment, without reading its secret (which would be checked against the access list):
/// `None` when there is no such item or it has no comment.
pub fn comment(service: &str, account: &str) -> Result<Option<String>, Error> {
    let keychain = login()?;
    let found = search(&keychain, service, account)
        .load_attributes(true)
        .limit(Limit::Max(1))
        .search();
    match found {
        Ok(results) => Ok(results
            .first()
            .and_then(|result| result.simplify_dict())
            .and_then(|mut attributes| attributes.remove(COMMENT_KEY))),
        Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn login() -> Result<SecKeychain, Error> {
    Ok(SecKeychain::default_for_domain(SecPreferencesDomain::User)?)
}

fn search(keychain: &SecKeychain, service: &str, account: &str) -> ItemSearchOptions {
    let mut options = ItemSearchOptions::new();
    options
        .keychains(std::slice::from_ref(keychain))
        .class(ItemClass::generic_password())
        .service(service)
        .account(account);
    options
}

fn add_owned(keychain: &SecKeychain, item: &Item<'_>, secret: &[u8]) -> Result<(), Error> {
    let access = self_access(item.label)?;
    let mut options = ItemAddOptions::new(ItemAddValue::Data {
        class: ItemClass::generic_password(),
        data: CFData::from_buffer(secret),
    });
    options
        .set_service(item.service)
        .set_account_name(item.account)
        .set_label(item.label)
        .set_comment(item.comment)
        .set_location(Location::FileKeychain(keychain.clone()));
    #[allow(deprecated)]
    let attributes = options.to_dictionary();
    let mut attributes = CFMutableDictionary::from(&attributes);
    // SAFETY: `kSecAttrAccess` is an immutable CFString constant the Security framework exports.
    let key = unsafe { kSecAttrAccess };
    attributes.add(&key.to_void(), &access.to_void());
    // SAFETY: `attributes` is a valid dictionary for the call's duration; no result is asked for.
    status(unsafe { SecItemAdd(attributes.as_concrete_TypeRef(), std::ptr::null_mut()) })
}

/// An access list trusting only the running program, by its designated requirement.
fn self_access(label: &str) -> Result<SecAccess, Error> {
    let mut app: CFTypeRef = std::ptr::null();
    // SAFETY: a null path names the calling program; `app` receives a retained reference.
    status(unsafe { SecTrustedApplicationCreateFromPath(std::ptr::null(), &raw mut app) })?;
    if app.is_null() {
        return Err(security_framework::base::Error::from_code(-50).into());
    }
    // SAFETY: `app` is a non-null reference the create call retained for us.
    let app = unsafe { CFType::wrap_under_create_rule(app) };
    let trusted = CFArray::from_CFTypes(&[app]);
    let label = CFString::new(label);
    let mut access: SecAccessRef = std::ptr::null_mut();
    // SAFETY: both arguments are valid CF objects for the call; `access` receives a retained
    // reference.
    status(unsafe {
        SecAccessCreate(
            label.as_concrete_TypeRef(),
            trusted.as_concrete_TypeRef(),
            &raw mut access,
        )
    })?;
    if access.is_null() {
        return Err(security_framework::base::Error::from_code(-50).into());
    }
    // SAFETY: `access` is a non-null reference the create call retained for us.
    Ok(unsafe { SecAccess::wrap_under_create_rule(access) })
}
