//! The person changes files only while driving, within the workspace.

use super::*;

#[tokio::test]
async fn the_persons_file_changes_are_confined_trusted_and_announced() -> Result {
    let machine = Machine::new()?;
    let spade = start(&machine, vec![Script::reply("Hi")], Vec::new()).await?;
    let (agent, conversation) = bot(&spade).await?;
    let workspace = machine.workspaces.of(&agent)?;
    let mut live = Live::open(&spade, &format!("/v1/conversations/{conversation}/live")).await?;
    let first = live
        .until("computer", |_| true)
        .await
        .ok_or("no computer frame")?;
    assert_eq!(first["driver"], "bot");

    let files = format!("/v1/agents/{agent}/files");
    workspace.write_bytes("keep.txt", b"original", 1024)?;
    let root = workspace.path()?;
    for driving in [false, true] {
        for route in [
            "workspace/file?path=keep.txt",
            "workspace/download?path=keep.txt",
        ] {
            let response = reqwest::Client::new()
                .get(format!("{}/v1/agents/{agent}/{route}", spade.base))
                .bearer_auth(TOKEN)
                .send()
                .await?;
            assert_eq!(response.status(), 200);
            if route.starts_with("workspace/download") {
                assert_eq!(response.bytes().await?.as_ref(), b"original");
            } else {
                assert_eq!(response.json::<Value>().await?["text"], "original");
            }
        }
        if driving {
            break;
        }
        let (_, terminal_error) = spade
            .post(
                &format!("/v1/agents/{agent}/terminal/input"),
                json!({"data_b64": b64("x")}),
            )
            .await?;
        let (status, error) = spade
            .put(
                &format!("{files}?path=keep.txt"),
                json!({"text": "changed"}),
            )
            .await?;
        assert_eq!(status, 409);
        assert_eq!(
            error.as_object().map(|o| o.keys().collect::<Vec<_>>()),
            terminal_error
                .as_object()
                .map(|o| o.keys().collect::<Vec<_>>())
        );
        for (route, body) in [
            ("upload", json!({"path": "new.bin", "data_b64": b64("x")})),
            ("mkdir", json!({"path": "new-dir"})),
            ("move", json!({"from": "keep.txt", "to": "moved.txt"})),
        ] {
            assert_eq!(spade.post(&format!("{files}/{route}"), body).await?.0, 409);
        }
        let response = reqwest::Client::new()
            .delete(format!(
                "{}/v1/agents/{agent}/workspace?path=keep.txt",
                spade.base
            ))
            .bearer_auth(TOKEN)
            .send()
            .await?;
        assert_eq!(response.status(), 409);
        assert_eq!(std::fs::read(root.join("keep.txt"))?, b"original");
        for absent in ["new.bin", "new-dir", "moved.txt"] {
            assert!(!root.join(absent).exists());
        }
        assert_eq!(
            spade
                .post(&format!("/v1/agents/{agent}/computer/take-over"), json!({}))
                .await?
                .0,
            204
        );
    }
    assert_eq!(
        spade
            .put(
                &format!("{files}?path=keep.txt"),
                json!({"text": "changed"})
            )
            .await?
            .0,
        204
    );
    assert_eq!(std::fs::read(root.join("keep.txt"))?, b"changed");
    let response = reqwest::Client::new()
        .delete(format!(
            "{}/v1/agents/{agent}/workspace?path=keep.txt",
            spade.base
        ))
        .bearer_auth(TOKEN)
        .send()
        .await?;
    assert_eq!(response.status(), 204);
    assert!(!root.join("keep.txt").exists());

    let (status, _) = spade
        .put(
            &format!("{files}?path=notes/plan.md"),
            json!({ "text": "# Plan" }),
        )
        .await?;
    assert_eq!(status, 204);
    assert!(workspace.file_trusted("notes/plan.md", b"# Plan"));
    let announced = live
        .until("files", |f| f["paths"] == json!(["notes/plan.md"]))
        .await;
    assert!(announced.is_some());

    let (status, _) = spade
        .post(
            &format!("{files}/upload"),
            json!({ "path": "in/data.bin", "data_b64": b64("\u{1}\u{2}") }),
        )
        .await?;
    assert_eq!(status, 204);
    assert!(workspace.file_trusted("in/data.bin", b"\x01\x02"));
    let (status, _) = spade
        .post(&format!("{files}/mkdir"), json!({ "path": "deep/er" }))
        .await?;
    assert_eq!(status, 204);
    assert!(workspace.path()?.join("deep/er").is_dir());

    let (status, _) = spade
        .post(
            &format!("{files}/move"),
            json!({ "from": "notes/plan.md", "to": "deep/er/plan.md" }),
        )
        .await?;
    assert_eq!(status, 204);
    assert!(workspace.file_trusted("deep/er/plan.md", b"# Plan"));
    assert!(!workspace.path()?.join("notes/plan.md").exists());
    let (status, _) = spade
        .post(
            &format!("{files}/move"),
            json!({ "from": "in/data.bin", "to": "deep/er/plan.md" }),
        )
        .await?;
    assert_eq!(status, 409, "a move never replaces what is there");

    // Nothing leaves the workspace: not by path, not through a link.
    let outside = tempfile::tempdir()?;
    std::os::unix::fs::symlink(outside.path(), workspace.path()?.join("out"))?;
    for path in ["../escape.txt", "/etc/escape.txt", "out/escape.txt"] {
        let (status, _) = spade
            .put(&format!("{files}?path={path}"), json!({ "text": "x" }))
            .await?;
        assert!(matches!(status, 400 | 422), "{path}: {status}");
    }
    let (status, _) = spade
        .post(&format!("{files}/mkdir"), json!({ "path": "out/inner" }))
        .await?;
    assert!(matches!(status, 400 | 422), "{status}");
    let (status, _) = spade
        .post(
            &format!("{files}/move"),
            json!({ "from": "in/data.bin", "to": "out/data.bin" }),
        )
        .await?;
    assert!(matches!(status, 400 | 422), "{status}");
    assert_eq!(std::fs::read_dir(outside.path())?.count(), 0);
    Ok(())
}
