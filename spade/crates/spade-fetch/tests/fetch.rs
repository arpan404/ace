//! Reading pages over HTTP from a local server: redirects, limits, content types, paging.

mod common;

use std::time::{Duration, Instant};

use common::{Result, local, start};
use spade_fetch::{FetchError, Fetcher, MOST_BYTES, Page, Policy};

#[tokio::test]
async fn a_page_reads_as_its_main_content_with_absolute_links() -> Result {
    let addr = start().await?;
    let got = local()
        .fetch(&format!("http://{addr}/page"), Page::default())
        .await?;
    assert_eq!(got.url, format!("http://{addr}/page"));
    assert_eq!(got.title.as_deref(), Some("A page"));
    assert_eq!(got.content_type, "text/html");
    assert_eq!(
        got.text,
        format!("# Hello\n\nSee [the next page](http://{addr}/next).")
    );
    assert_eq!(got.total_chars, got.text.chars().count());
    assert_eq!(got.next_offset, None);
    Ok(())
}

#[tokio::test]
async fn redirects_are_followed_up_to_five_and_report_where_they_ended() -> Result {
    let addr = start().await?;
    // /hop/4 → 3 → 2 → 1 → 0 → /page: five redirects.
    let got = local()
        .fetch(&format!("http://{addr}/hop/4"), Page::default())
        .await?;
    assert_eq!(got.url, format!("http://{addr}/page"));
    assert_eq!(got.title.as_deref(), Some("A page"));
    Ok(())
}

#[tokio::test]
async fn a_sixth_redirect_is_refused() -> Result {
    let addr = start().await?;
    let got = local()
        .fetch(&format!("http://{addr}/hop/5"), Page::default())
        .await;
    assert_eq!(got, Err(FetchError::TooManyRedirects));
    Ok(())
}

#[tokio::test]
async fn a_redirect_to_another_scheme_is_refused() -> Result {
    let addr = start().await?;
    let got = local()
        .fetch(
            &format!("http://{addr}/to?where=file:///etc/passwd"),
            Page::default(),
        )
        .await;
    assert_eq!(got, Err(FetchError::Scheme("file".to_owned())));
    Ok(())
}

#[tokio::test]
async fn a_body_over_the_cap_is_refused() -> Result {
    let addr = start().await?;
    let got = local()
        .fetch(&format!("http://{addr}/big"), Page::default())
        .await;
    assert_eq!(got, Err(FetchError::TooLarge));
    let ok = local()
        .fetch(&format!("http://{addr}/just-under"), Page::default())
        .await?;
    assert_eq!(ok.total_chars, MOST_BYTES);
    Ok(())
}

#[tokio::test]
async fn an_endless_body_stops_at_the_cap_instead_of_reading_on() -> Result {
    let addr = start().await?;
    let started = Instant::now();
    let got = local()
        .fetch(&format!("http://{addr}/endless"), Page::default())
        .await;
    assert_eq!(got, Err(FetchError::TooLarge));
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "it should not run to the timeout"
    );
    Ok(())
}

#[tokio::test]
async fn json_and_xml_pass_through_trimmed() -> Result {
    let addr = start().await?;
    let json = local()
        .fetch(&format!("http://{addr}/json"), Page::default())
        .await?;
    assert_eq!(json.text, "{\"a\": [1, 2]}");
    assert_eq!(json.content_type, "application/json");
    assert_eq!(json.title, None);
    let xml = local()
        .fetch(&format!("http://{addr}/xml"), Page::default())
        .await?;
    assert_eq!(xml.text, "<rss><item/></rss>");
    Ok(())
}

#[tokio::test]
async fn unreadable_and_untyped_content_is_refused_without_its_body() -> Result {
    let addr = start().await?;
    let pdf = local()
        .fetch(&format!("http://{addr}/pdf"), Page::default())
        .await;
    assert_eq!(
        pdf,
        Err(FetchError::Unsupported("application/pdf".to_owned()))
    );
    let untyped = local()
        .fetch(&format!("http://{addr}/untyped"), Page::default())
        .await;
    assert_eq!(untyped, Err(FetchError::NoContentType));
    Ok(())
}

#[tokio::test]
async fn a_failing_server_gives_its_status_and_never_its_body() -> Result {
    let addr = start().await?;
    let got = local()
        .fetch(&format!("http://{addr}/broken"), Page::default())
        .await;
    assert_eq!(got, Err(FetchError::Status(500)));
    let message = got.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(!message.contains("SECRET"), "{message}");
    Ok(())
}

#[tokio::test]
async fn a_slow_page_times_out() -> Result {
    let addr = start().await?;
    let fetcher = Fetcher::new(Policy::allowing_loopback(), Duration::from_millis(300));
    let got = fetcher
        .fetch(&format!("http://{addr}/slow"), Page::default())
        .await;
    assert!(matches!(got, Err(FetchError::TimedOut(_))), "{got:?}");
    Ok(())
}

#[tokio::test]
async fn pages_of_text_walk_to_the_end() -> Result {
    let addr = start().await?;
    let url = format!("http://{addr}/long");
    let mut offset = 0;
    let mut text = String::new();
    loop {
        let got = local()
            .fetch(
                &url,
                Page {
                    offset,
                    max_chars: 20,
                },
            )
            .await?;
        assert_eq!(got.total_chars, 50);
        text.push_str(&got.text);
        match got.next_offset {
            Some(next) => offset = next,
            None => break,
        }
    }
    assert_eq!(text, "0123456789".repeat(5));
    Ok(())
}
