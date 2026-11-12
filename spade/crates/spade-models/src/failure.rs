//! Why a call failed: whether the endpoint ever answered, and whether sending the same request
//! again may help. A request that never got an answer was never billed.

use std::time::Duration;

use reqwest::StatusCode;
use reqwest::header::HeaderMap;

use crate::error::ModelError;

/// The error for a failed call on `model`. `answered` is whether the endpoint had already begun a
/// successful answer (its stream started): a failure after that is the model's, never retried.
pub(crate) fn read(model: &str, error: &genai::Error, answered: bool) -> ModelError {
    let message = error.to_string();
    if answered {
        return ModelError::Provider {
            model: model.to_owned(),
            message,
        };
    }
    match unanswered(error) {
        Some(Unanswered::Status(status, headers)) => ModelError::Unanswered {
            model: model.to_owned(),
            message,
            transient: transient_status(status),
            retry_after: headers.and_then(retry_after),
            status: Some(status.as_u16()),
        },
        Some(Unanswered::Network) => ModelError::Unanswered {
            model: model.to_owned(),
            message,
            transient: true,
            retry_after: None,
            status: None,
        },
        None => ModelError::Provider {
            model: model.to_owned(),
            message,
        },
    }
}

enum Unanswered<'a> {
    /// The endpoint refused the request with this HTTP status.
    Status(StatusCode, Option<&'a HeaderMap>),
    /// The request never reached the endpoint, or no response came back.
    Network,
}

fn unanswered(error: &genai::Error) -> Option<Unanswered<'_>> {
    if let Some(status) = error.status() {
        return Some(Unanswered::Status(status, error.headers()));
    }
    match error {
        genai::Error::WebModelCall { webc_error, .. }
        | genai::Error::WebAdapterCall { webc_error, .. } => match webc_error {
            genai::webc::Error::Reqwest(failed) => not_sent(failed).then_some(Unanswered::Network),
            _ => None,
        },
        // A stream's own failure wraps what the HTTP layer said: a refused status, or a request
        // that could not be sent.
        genai::Error::WebStream { error, .. } => {
            if let Some(inner) = error.downcast_ref::<genai::Error>() {
                return unanswered(inner);
            }
            match error.downcast_ref::<reqwest::Error>() {
                Some(failed) => match failed.status() {
                    Some(status) => Some(Unanswered::Status(status, None)),
                    None => not_sent(failed).then_some(Unanswered::Network),
                },
                None => None,
            }
        }
        _ => None,
    }
}

/// The request never got a response: it could not connect or could not be sent. A body cut
/// short or unreadable (`is_body`, `is_decode`) came after a response, so the endpoint answered
/// and may have billed it; that is never sent again.
fn not_sent(error: &reqwest::Error) -> bool {
    (error.is_connect() || error.is_request()) && !error.is_body() && !error.is_decode()
}

/// A timeout, a rate limit or the server's own trouble passes; a bad request or a refused key
/// does not.
fn transient_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

/// The longest wait read from an endpoint. Anything longer means the same to a caller (too long
/// to wait for); capping it keeps any number an endpoint sends a valid duration.
const LONGEST_HINT: Duration = Duration::from_secs(24 * 60 * 60);

/// The wait an endpoint asked for: `retry-after-ms`, else `retry-after` in seconds, at most
/// [`LONGEST_HINT`]. A date or anything unreadable is no hint.
fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let seconds = |name: &str, scale: f64| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value / scale)
    };
    let wait = seconds("retry-after-ms", 1000.0).or_else(|| seconds("retry-after", 1.0))?;
    // Never `from_secs_f64`, which panics on a number too big for a duration.
    Some(
        Duration::try_from_secs_f64(wait)
            .unwrap_or(LONGEST_HINT)
            .min(LONGEST_HINT),
    )
}

#[cfg(test)]
mod tests {
    use reqwest::header::HeaderValue;

    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_static(value));
        }
        map
    }

    fn refused(status: u16, pairs: &[(&'static str, &'static str)]) -> genai::Error {
        genai::Error::HttpError {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::IM_A_TEAPOT),
            canonical_reason: String::new(),
            body: String::new(),
            headers: Box::new(headers(pairs)),
        }
    }

    #[test]
    fn rate_limits_and_server_errors_are_worth_sending_again_and_bad_requests_are_not() {
        for (status, transient) in [
            (429, true),
            (500, true),
            (503, true),
            (408, true),
            (400, false),
            (401, false),
        ] {
            let error = read("m", &refused(status, &[]), false);
            assert!(
                matches!(error, ModelError::Unanswered { .. }),
                "{status}: {error:?}"
            );
            assert_eq!(error.transient(), transient, "{status}");
        }
    }

    #[test]
    fn the_endpoints_wait_is_read_in_milliseconds_or_seconds_and_a_date_is_no_hint() {
        let wait = |pairs| read("m", &refused(429, pairs), false).retry_after();
        assert_eq!(wait(&[("retry-after", "3")]), Some(Duration::from_secs(3)));
        assert_eq!(
            wait(&[("retry-after-ms", "1500"), ("retry-after", "9")]),
            Some(Duration::from_millis(1500))
        );
        assert_eq!(
            wait(&[("retry-after", "Wed, 21 Oct 2026 07:28:00 GMT")]),
            None
        );
        assert_eq!(wait(&[("retry-after", "-1")]), None);
        // Numbers too big for a duration are the longest wait, never a panic.
        for huge in [
            &[("retry-after", "1e20")][..],
            &[("retry-after", "9999999999999999999999999")],
            &[("retry-after-ms", "1e300")],
        ] {
            assert_eq!(wait(huge), Some(LONGEST_HINT), "{huge:?}");
        }
    }

    #[test]
    fn a_failure_after_the_answer_began_is_the_models_and_never_sent_again() {
        let error = read("m", &refused(503, &[]), true);
        assert!(matches!(error, ModelError::Provider { .. }));
        assert!(!error.transient());
    }

    #[test]
    fn a_stream_that_was_refused_before_it_began_is_unanswered() {
        let error = genai::Error::WebStream {
            model_iden: genai::ModelIden::new(genai::adapter::AdapterKind::OpenAI, "m"),
            cause: "refused".into(),
            error: Box::new(refused(502, &[("retry-after", "1")])),
        };
        let read = read("m", &error, false);
        assert!(read.transient());
        assert_eq!(read.retry_after(), Some(Duration::from_secs(1)));
    }
}
