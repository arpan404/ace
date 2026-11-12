//! PDFs read through `spade-docs` (ADR 0134): paged like any page, and refused without a reader.

mod common;

use common::{Result, local, serve_bytes};
use pdf_extract::content::{Content, Operation};
use pdf_extract::{Document, Object, Stream, dictionary};
use spade_docs::Extractor;
use spade_fetch::{FetchError, Page};

/// A one-page PDF saying `text`, kept for the life of the test process.
fn pdf(text: &str) -> Result<&'static [u8]> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier",
    });
    let resources = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
    let content = Content {
        operations: vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 12.into()]),
            Operation::new("Td", vec![72.into(), 720.into()]),
            Operation::new("Tj", vec![Object::string_literal(text)]),
            Operation::new("ET", vec![]),
        ],
    };
    let contents = doc.add_object(Stream::new(dictionary! {}, content.encode()?));
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "Contents" => contents,
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1,
            "Resources" => resources,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out)?;
    Ok(out.leak())
}

#[tokio::test]
async fn a_pdf_reads_as_its_text_a_window_at_a_time() -> Result {
    let words = "Shipping terms apply to every order placed";
    let addr = serve_bytes("application/pdf", pdf(words)?).await?;
    let fetcher = local().with_documents(Extractor::in_process());
    let first = fetcher
        .fetch(
            &format!("http://{addr}/"),
            Page {
                offset: 0,
                max_chars: 12,
            },
        )
        .await?;
    assert_eq!(first.content_type, "application/pdf");
    assert_eq!(first.text, "Shipping ter");
    assert_eq!(first.next_offset, Some(12));
    let all = fetcher
        .fetch(&format!("http://{addr}/"), Page::default())
        .await?;
    assert!(all.text.contains(words), "{}", all.text);
    Ok(())
}

#[tokio::test]
async fn a_pdf_sent_as_generic_binary_is_read_and_other_binary_is_not() -> Result {
    let fetcher = local().with_documents(Extractor::in_process());
    let addr = serve_bytes("application/octet-stream", pdf("Binary but a PDF")?).await?;
    let got = fetcher
        .fetch(&format!("http://{addr}/"), Page::default())
        .await?;
    assert!(got.text.contains("Binary but a PDF"), "{}", got.text);
    let other = serve_bytes("application/octet-stream", b"\x00\x01\x02 secret").await?;
    assert_eq!(
        fetcher
            .fetch(&format!("http://{other}/"), Page::default())
            .await,
        Err(FetchError::Unsupported(
            "application/octet-stream".to_owned()
        ))
    );
    Ok(())
}

#[tokio::test]
async fn without_a_document_reader_a_pdf_is_refused() -> Result {
    let addr = serve_bytes("application/pdf", pdf("hidden")?).await?;
    assert_eq!(
        local()
            .fetch(&format!("http://{addr}/"), Page::default())
            .await,
        Err(FetchError::Unsupported("application/pdf".to_owned()))
    );
    Ok(())
}

#[tokio::test]
async fn a_damaged_pdf_fails_in_one_line_without_its_content() -> Result {
    let addr = serve_bytes("application/pdf", b"%PDF-1.7 secret words, no objects").await?;
    let got = local()
        .with_documents(Extractor::in_process())
        .fetch(&format!("http://{addr}/"), Page::default())
        .await;
    match got {
        Err(FetchError::Document(why)) => assert!(!why.contains("secret"), "{why}"),
        other => panic!("expected a document error, got {other:?}"),
    }
    Ok(())
}
