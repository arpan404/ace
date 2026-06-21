use ace_git::{GithubCliClient, ProcessRunner, TokioProcessRunner};
use async_trait::async_trait;
use axum::{
    Router,
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use reqwest::{Url, redirect::Policy};
use serde::Deserialize;
use std::{path::PathBuf, sync::Arc, time::Duration};
use thiserror::Error;

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

pub struct GithubImageProxyState<R, F>
where
    R: ProcessRunner,
    F: GithubImageFetcher,
{
    github: GithubCliClient<R>,
    fetcher: Arc<F>,
}

impl<R, F> Clone for GithubImageProxyState<R, F>
where
    R: ProcessRunner,
    F: GithubImageFetcher,
{
    fn clone(&self) -> Self {
        Self {
            github: self.github.clone(),
            fetcher: Arc::clone(&self.fetcher),
        }
    }
}

impl GithubImageProxyState<TokioProcessRunner, ReqwestGithubImageFetcher> {
    #[must_use]
    pub fn production() -> Self {
        Self {
            github: GithubCliClient::new(),
            fetcher: Arc::new(ReqwestGithubImageFetcher::new()),
        }
    }
}

impl<R, F> GithubImageProxyState<R, F>
where
    R: ProcessRunner,
    F: GithubImageFetcher,
{
    #[cfg(test)]
    #[must_use]
    pub fn new(github: GithubCliClient<R>, fetcher: Arc<F>) -> Self {
        Self { github, fetcher }
    }
}

pub fn router() -> Router {
    router_with_state(GithubImageProxyState::<
        TokioProcessRunner,
        ReqwestGithubImageFetcher,
    >::production())
}

pub fn router_with_state<R, F>(state: GithubImageProxyState<R, F>) -> Router
where
    R: ProcessRunner + 'static,
    F: GithubImageFetcher + 'static,
{
    Router::new()
        .route(
            "/api/github-issue-image",
            get(proxy_github_issue_image::<R, F>),
        )
        .with_state(state)
}

#[async_trait]
pub trait GithubImageFetcher: Send + Sync {
    async fn fetch(
        &self,
        url: Url,
        authorization: Option<String>,
    ) -> Result<ProxiedGithubImage, ImageProxyError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxiedGithubImage {
    pub content_type: String,
    pub bytes: Bytes,
}

#[derive(Debug, Error)]
pub enum ImageProxyError {
    #[error("missing cwd or url parameter")]
    MissingParameter,
    #[error("unsupported image URL")]
    UnsupportedUrl,
    #[error("GitHub image fetch failed")]
    FetchFailed,
    #[error("GitHub image response was not an image")]
    NotImage,
    #[error("GitHub image exceeded {limit} bytes")]
    TooLarge { limit: usize },
}

#[derive(Debug, Deserialize)]
struct ImageProxyQuery {
    cwd: Option<String>,
    url: Option<String>,
}

async fn proxy_github_issue_image<R, F>(
    State(state): State<GithubImageProxyState<R, F>>,
    Query(query): Query<ImageProxyQuery>,
) -> Result<Response, ImageProxyError>
where
    R: ProcessRunner,
    F: GithubImageFetcher,
{
    let cwd = query.cwd.filter(|cwd| !cwd.trim().is_empty());
    let raw_url = query.url.filter(|url| !url.trim().is_empty());
    let (cwd, raw_url) = match (cwd, raw_url) {
        (Some(cwd), Some(raw_url)) => (PathBuf::from(cwd), raw_url),
        _ => return Err(ImageProxyError::MissingParameter),
    };

    let url = resolve_allowed_github_issue_image_url(&raw_url)?;
    let token = state.github.auth_token(&cwd).await.unwrap_or_default();
    let auth_header = (!token.is_empty()).then(|| format!("Bearer {token}"));

    let image = match state.fetcher.fetch(url.clone(), auth_header).await {
        Ok(image) => image,
        Err(error) if !token.is_empty() => state.fetcher.fetch(url, None).await.or(Err(error))?,
        Err(error) => return Err(error),
    };

    Ok(image_response(image))
}

fn image_response(image: ProxiedGithubImage) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&image.content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("image/*")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    (headers, image.bytes).into_response()
}

fn resolve_allowed_github_issue_image_url(raw_url: &str) -> Result<Url, ImageProxyError> {
    let parsed = Url::parse(raw_url).map_err(|_| ImageProxyError::UnsupportedUrl)?;
    if parsed.scheme() != "https" {
        return Err(ImageProxyError::UnsupportedUrl);
    }

    let hostname = parsed
        .host_str()
        .ok_or(ImageProxyError::UnsupportedUrl)?
        .to_ascii_lowercase();
    is_allowed_github_issue_image_url(&parsed, &hostname)
        .then_some(parsed)
        .ok_or(ImageProxyError::UnsupportedUrl)
}

fn is_allowed_github_issue_image_url(parsed: &Url, hostname: &str) -> bool {
    if parsed.scheme() != "https" {
        return false;
    }
    if hostname == "github.com" {
        return parsed.path().starts_with("/user-attachments/");
    }
    hostname.ends_with(".githubusercontent.com") || hostname.ends_with(".githubassets.com")
}

#[derive(Clone)]
pub struct ReqwestGithubImageFetcher {
    client: reqwest::Client,
}

impl ReqwestGithubImageFetcher {
    #[must_use]
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    return attempt.stop();
                }
                let url = attempt.url();
                let Some(hostname) = url.host_str().map(str::to_ascii_lowercase) else {
                    return attempt.stop();
                };
                if is_allowed_github_issue_image_url(url, &hostname) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .timeout(FETCH_TIMEOUT)
            .user_agent("ace-github-image-proxy")
            .build()
            .expect("build reqwest client");
        Self { client }
    }
}

impl Default for ReqwestGithubImageFetcher {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl GithubImageFetcher for ReqwestGithubImageFetcher {
    async fn fetch(
        &self,
        url: Url,
        authorization: Option<String>,
    ) -> Result<ProxiedGithubImage, ImageProxyError> {
        let mut request = self
            .client
            .get(url)
            .header(header::ACCEPT.as_str(), "image/*,*/*;q=0.8");
        if let Some(authorization) = authorization {
            request = request.header(header::AUTHORIZATION.as_str(), authorization);
        }

        let response = request
            .send()
            .await
            .map_err(|_| ImageProxyError::FetchFailed)?;
        if !response.status().is_success() {
            return Err(ImageProxyError::FetchFailed);
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("image/*")
            .to_string();
        if !content_type.to_ascii_lowercase().starts_with("image/") {
            return Err(ImageProxyError::NotImage);
        }
        let content_length = response.content_length().unwrap_or(0);
        if content_length > MAX_IMAGE_BYTES as u64 {
            return Err(ImageProxyError::TooLarge {
                limit: MAX_IMAGE_BYTES,
            });
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|_| ImageProxyError::FetchFailed)?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(ImageProxyError::TooLarge {
                limit: MAX_IMAGE_BYTES,
            });
        }

        Ok(ProxiedGithubImage {
            content_type,
            bytes,
        })
    }
}

impl IntoResponse for ImageProxyError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::MissingParameter | Self::UnsupportedUrl => StatusCode::BAD_REQUEST,
            Self::TooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
            Self::FetchFailed | Self::NotImage => StatusCode::BAD_GATEWAY,
        };
        (status, self.to_string()).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_git::{CommandOutput, CommandRequest, GitToolError};
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };
    use tower::ServiceExt;

    #[derive(Debug)]
    struct FakeRunner {
        outputs: Mutex<VecDeque<CommandOutput>>,
        requests: Mutex<Vec<CommandRequest>>,
    }

    impl FakeRunner {
        fn new(outputs: Vec<CommandOutput>) -> Self {
            Self {
                outputs: Mutex::new(VecDeque::from(outputs)),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<CommandRequest> {
            self.requests.lock().expect("lock requests").clone()
        }
    }

    #[async_trait]
    impl ProcessRunner for FakeRunner {
        async fn run(&self, request: CommandRequest) -> ace_git::Result<CommandOutput> {
            self.requests.lock().expect("lock requests").push(request);
            self.outputs
                .lock()
                .expect("lock outputs")
                .pop_front()
                .ok_or_else(|| GitToolError::Parse {
                    context: "fake runner",
                    message: "no fake output queued".to_string(),
                })
        }
    }

    #[derive(Debug)]
    struct FakeFetcher {
        outputs: Mutex<VecDeque<Result<ProxiedGithubImage, ImageProxyError>>>,
        requests: Mutex<Vec<(String, Option<String>)>>,
    }

    impl FakeFetcher {
        fn new(outputs: Vec<Result<ProxiedGithubImage, ImageProxyError>>) -> Self {
            Self {
                outputs: Mutex::new(VecDeque::from(outputs)),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<(String, Option<String>)> {
            self.requests.lock().expect("lock requests").clone()
        }
    }

    #[async_trait]
    impl GithubImageFetcher for FakeFetcher {
        async fn fetch(
            &self,
            url: Url,
            authorization: Option<String>,
        ) -> Result<ProxiedGithubImage, ImageProxyError> {
            self.requests
                .lock()
                .expect("lock requests")
                .push((url.to_string(), authorization));
            self.outputs
                .lock()
                .expect("lock outputs")
                .pop_front()
                .unwrap_or(Err(ImageProxyError::FetchFailed))
        }
    }

    fn ok(stdout: impl AsRef<[u8]>) -> CommandOutput {
        CommandOutput {
            status: 0,
            stdout: stdout.as_ref().to_vec(),
            stderr: Vec::new(),
        }
    }

    fn image() -> ProxiedGithubImage {
        ProxiedGithubImage {
            content_type: "image/png".to_string(),
            bytes: Bytes::from_static(b"image-bytes"),
        }
    }

    #[test]
    fn allows_only_github_issue_image_urls() {
        assert!(
            resolve_allowed_github_issue_image_url(
                "https://private-user-images.githubusercontent.com/1/image.png"
            )
            .is_ok()
        );
        assert!(
            resolve_allowed_github_issue_image_url(
                "https://github.com/user-attachments/assets/abc"
            )
            .is_ok()
        );
        assert!(
            resolve_allowed_github_issue_image_url("http://github.com/user-attachments/a").is_err()
        );
        assert!(
            resolve_allowed_github_issue_image_url("https://github.com/octo/repo/raw/a.png")
                .is_err()
        );
        assert!(resolve_allowed_github_issue_image_url("https://example.com/a.png").is_err());
    }

    #[tokio::test]
    async fn proxies_github_images_with_gh_auth_token() {
        let runner = Arc::new(FakeRunner::new(vec![ok("ghs_test_token\n")]));
        let fetcher = Arc::new(FakeFetcher::new(vec![Ok(image())]));
        let router = router_with_state(GithubImageProxyState::new(
            GithubCliClient::with_runner(runner.clone()),
            fetcher.clone(),
        ));

        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/github-issue-image?cwd=%2Frepo&url=https%3A%2F%2Fprivate-user-images.githubusercontent.com%2F123%2Fexample.png")
                    .body(axum::body::Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "image/png"
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(body, Bytes::from_static(b"image-bytes"));
        assert_eq!(runner.requests()[0].args, vec!["auth", "token"]);
        assert_eq!(
            fetcher.requests()[0],
            (
                "https://private-user-images.githubusercontent.com/123/example.png".to_string(),
                Some("Bearer ghs_test_token".to_string())
            )
        );
    }

    #[tokio::test]
    async fn rejects_non_github_image_urls_without_fetching_token() {
        let runner = Arc::new(FakeRunner::new(vec![]));
        let fetcher = Arc::new(FakeFetcher::new(vec![]));
        let router = router_with_state(GithubImageProxyState::new(
            GithubCliClient::with_runner(runner.clone()),
            fetcher.clone(),
        ));

        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/github-issue-image?cwd=%2Frepo&url=https%3A%2F%2Fexample.com%2Fbad.png")
                    .body(axum::body::Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(runner.requests().is_empty());
        assert!(fetcher.requests().is_empty());
    }

    #[tokio::test]
    async fn retries_without_auth_when_authenticated_fetch_fails() {
        let runner = Arc::new(FakeRunner::new(vec![ok("ghs_test_token\n")]));
        let fetcher = Arc::new(FakeFetcher::new(vec![
            Err(ImageProxyError::FetchFailed),
            Ok(image()),
        ]));
        let router = router_with_state(GithubImageProxyState::new(
            GithubCliClient::with_runner(runner),
            fetcher.clone(),
        ));

        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/github-issue-image?cwd=%2Frepo&url=https%3A%2F%2Fprivate-user-images.githubusercontent.com%2F123%2Fexample.png")
                    .body(axum::body::Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let requests = fetcher.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].1, Some("Bearer ghs_test_token".to_string()));
        assert_eq!(requests[1].1, None);
    }
}
