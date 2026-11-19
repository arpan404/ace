//! Looking up host names. Injected so tests can point a made-up name at a local server.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;

/// The addresses a lookup found.
pub type Lookup<'a> = Pin<Box<dyn Future<Output = io::Result<Vec<SocketAddr>>> + Send + 'a>>;

/// Resolves a host name to the addresses to connect to.
pub trait Resolve: Send + Sync {
    fn lookup<'a>(&'a self, host: &'a str, port: u16) -> Lookup<'a>;
}

/// The operating system's resolver.
pub struct SystemResolver;

impl Resolve for SystemResolver {
    fn lookup<'a>(&'a self, host: &'a str, port: u16) -> Lookup<'a> {
        Box::pin(async move { Ok(tokio::net::lookup_host((host, port)).await?.collect()) })
    }
}

/// The HTTP client's own resolver: it answers nothing, so the client connects only to the
/// addresses Spade checked and pinned.
pub(crate) struct Nowhere;

impl reqwest::dns::Resolve for Nowhere {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let name = name.as_str().to_owned();
        Box::pin(async move { Err(format!("{name} was not checked before connecting").into()) })
    }
}
