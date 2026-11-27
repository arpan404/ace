// SPDX-License-Identifier: Apache-2.0
//! The access rules of a devices channel (`packages/devices/src/bridge.ts`): who may
//! speak, whose thread a device may be seen from, and which requests are refused
//! before any work starts.
//!
//! The channel's composition — held pushes, the per-device queue, the media
//! binding, stills — is the shell's, built from the modules beside this one.

/// A channel whose connection went, or no longer authorizes, says nothing.
pub const ACCESS_REVOKED: &str = "Device access revoked";
/// A device belongs to a thread this connection may not read.
pub const THREAD_ACCESS_DENIED: &str = "Device thread access denied";
/// The channel's own request budget.
pub const TOO_MANY_REQUESTS: &str = "Too many pending device requests";
/// A `controller: "agent"` request naming an agent this connection cannot see.
pub const UNKNOWN_AGENT: &str = "Unknown device agent";

/// At most this many requests may be in flight on one channel (`bridge.ts:272`).
pub const MAX_PENDING_REQUESTS: usize = 32;

/// What the connection behind a channel can still vouch for.
#[derive(Clone, Copy)]
pub struct Peer<'a> {
    /// The socket is open and its session is not revoked.
    pub authorized: bool,
    /// A hook the shell supplies: may this connection read that thread?
    pub can_read_thread: &'a dyn Fn(&str) -> bool,
    /// May this connection name that agent in that thread?
    pub agent_exists: &'a dyn Fn(&str, &str) -> bool,
}

/// `access`: the channel is open and its connection still authorizes.
pub fn access(closed: bool, authorized: bool) -> Result<(), String> {
    if closed || !authorized {
        return Err(String::from(ACCESS_REVOKED));
    }
    Ok(())
}

/// `deviceAccess`: the channel may speak, and the device's thread is one this
/// connection can read.
pub fn device_access(
    closed: bool,
    peer: &Peer<'_>,
    bound_thread: Option<&str>,
) -> Result<(), String> {
    access(closed, peer.authorized)?;
    if let Some(thread) = bound_thread
        && !(peer.can_read_thread)(thread)
    {
        return Err(String::from(THREAD_ACCESS_DENIED));
    }
    Ok(())
}

/// A request's identity checks, in `bridge.ts`'s order, before any work starts.
#[derive(Debug, Clone, Copy, Default)]
pub struct RequestFacts<'a> {
    /// The requests in flight on this channel.
    pub pending: usize,
    /// The request's own `threadId`, when it carries one.
    pub thread_id: Option<&'a str>,
    /// `controller: "agent"`'s thread and agent, when that is the operation.
    pub controller_agent: Option<(&'a str, &'a str)>,
    /// The device the request names, when it names one.
    pub device_id: Option<&'a str>,
    /// The thread the named device belongs to, when it belongs to one.
    pub bound_thread: Option<&'a str>,
}

/// `request`'s refusals before the operation runs.
pub fn check_request(
    closed: bool,
    peer: &Peer<'_>,
    facts: &RequestFacts<'_>,
) -> Result<(), String> {
    access(closed, peer.authorized)?;
    if facts.pending >= MAX_PENDING_REQUESTS {
        return Err(String::from(TOO_MANY_REQUESTS));
    }
    if let Some(thread) = facts.thread_id
        && !(peer.can_read_thread)(thread)
    {
        return Err(String::from("Thread access denied"));
    }
    if let Some((thread, agent)) = facts.controller_agent
        && (thread.is_empty() || agent.is_empty() || !(peer.agent_exists)(thread, agent))
    {
        return Err(String::from(UNKNOWN_AGENT));
    }
    if facts.device_id.is_some() {
        device_access(closed, peer, facts.bound_thread)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
