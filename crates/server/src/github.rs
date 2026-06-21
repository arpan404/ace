mod error;
mod image_proxy;
mod mapping;
mod routes;
mod service;

#[cfg(test)]
mod tests;

pub use error::GithubApiError;
pub use image_proxy::{
    GithubImageFetcher, ImageProxyError, ProxiedGithubImage, router as image_proxy_router,
};
pub use routes::{router, router_with_state};
pub use service::{
    GithubApiState, GithubImageProxyResponse, GithubService, WorkflowRunLogResponse,
};
