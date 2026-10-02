use ace_screen_helper_windows::{
    codec::{self, Header, Request},
    coordinates::{output_size, Bounds, Mapping},
    errors::{Code, Error},
    references::References,
    stream::Stream,
    tiles::Tiles,
    tree::{self, Node, Query, Source},
};
#[test]
fn fragmented_lines_preserve_unicode_and_reject_oversize_or_incomplete_commands() {
    let bytes = b"{\"version\":2,\"id\":\"r\",\"op\":\"text.type\",\"text\":\"hello\"}\n";
    let mut reader = std::io::BufReader::with_capacity(3, &bytes[..]);
    let request = Request::decode(&codec::read_line(&mut reader).unwrap().unwrap()).unwrap();
    assert_eq!(request.get::<String>("text").unwrap(), "hello");
    assert!(codec::read_line(&mut reader).unwrap().is_none());
    assert!(codec::read_line(&mut &b"truncated"[..]).is_err());
    assert!(codec::read_line(&mut vec![b'x'; codec::MAX_LINE + 1].as_slice()).is_err());
    let request = Request::decode(
        "{\"version\":2,\"id\":\"r\",\"op\":\"text.type\",\"text\":\"你好 😀\"}".as_bytes(),
    )
    .unwrap();
    assert_eq!(request.get::<String>("text").unwrap(), "你好 😀");
    assert!(Request::decode(br#"{"version":3,"id":"r","op":"hello"}"#).is_err());
    assert!(Request::decode(br#"{"version":2,"id":"../r","op":"hello"}"#).is_err());
}
#[test]
fn replies_preserve_correlation_and_use_typed_errors_only_in_v2() {
    for version in [1, 2] {
        let request = Request::decode(
            format!("{{\"version\":{version},\"id\":\"call-3\",\"op\":\"hello\"}}").as_bytes(),
        )
        .unwrap();
        let mut output = vec![];
        codec::reply(
            &mut output,
            &request,
            Err(Error::new(Code::Busy, "UAC active")),
        )
        .unwrap();
        let reply: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(reply["id"], "call-3");
        assert_eq!(reply["ok"], false);
        if version == 2 {
            assert_eq!(reply["error"]["code"], "busy");
        } else {
            assert_eq!(reply["error"], "UAC active");
        }
        codec::reply(
            &mut output,
            &request,
            Ok(serde_json::json!({"pixels": "x".repeat(codec::MAX_REPLY)})),
        )
        .unwrap();
        assert!(output.len() < 1024);
    }
}
#[test]
fn frame_packets_delimit_exact_jpeg_bytes_and_preserve_scale() {
    let jpeg = codec::jpeg(&[255; 12], 2, 2).unwrap();
    let mut decoder = jpeg_decoder::Decoder::new(jpeg.as_slice());
    assert_eq!(decoder.decode().unwrap(), vec![255; 12]);
    assert_eq!(&jpeg[..2], &[255, 216]);
    assert_eq!(&jpeg[jpeg.len() - 2..], &[255, 217]);
    let mut header = Header {
        version: 2,
        session_id: "s".into(),
        seq: 7,
        capture_generation: Some(1),
        ts: 123.0,
        width: 2,
        height: 2,
        scale: 1.5,
        codec: "jpeg".into(),
        bytes: jpeg.len(),
        dirty_rects: None,
    };
    let packet = codec::packet(&header, &jpeg).unwrap();
    let length = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
    let decoded: Header = serde_json::from_slice(&packet[4..4 + length]).unwrap();
    assert_eq!(decoded.seq, 7);
    assert_eq!(decoded.scale, 1.5);
    assert_eq!(&packet[4 + length..], jpeg);
    header.bytes += 1;
    assert!(codec::packet(&header, &jpeg).is_err());
    assert!(codec::jpeg(&[0; 3], 3841, 1).is_err());
}
fn mapping(dpi: u32) -> Mapping {
    Mapping {
        target: Bounds {
            x: -1920.0,
            y: 20.0,
            w: 1200.0,
            h: 900.0,
        },
        desktop: Bounds {
            x: -1920.0,
            y: 0.0,
            w: 3840.0,
            h: 2160.0,
        },
        dpi,
    }
}
#[test]
fn logical_points_map_through_dpi_and_negative_monitor_origins() {
    assert_eq!(mapping(144).physical(100.0, 100.0).unwrap(), (-1770, 170));
    assert_eq!(mapping(192).physical(100.0, 100.0).unwrap(), (-1720, 220));
    assert_eq!(mapping(96).absolute(0.0, 0.0).unwrap(), (0, 607));
    assert!(mapping(144).physical(800.0, 0.0).is_err());
    assert!(mapping(144).physical(-1.0, 0.0).is_err());
    assert!(mapping(144).physical(f64::NAN, 0.0).is_err());
    assert_eq!(output_size(7680, 4320).unwrap(), (3840, 2160));
    assert_eq!(output_size(4000, 1000).unwrap(), (3840, 960));
    assert!(output_size(0, 100).is_err());
}
#[test]
fn identical_pixels_emit_nothing_and_a_changed_edge_tile_is_reported() {
    let mut tiles = Tiles::default();
    let mut pixels = vec![0; 130 * 65 * 3];
    assert_eq!(tiles.changed(&pixels, 130, 65).unwrap().len(), 6);
    assert!(tiles.changed(&pixels, 130, 65).unwrap().is_empty());
    *pixels.last_mut().unwrap() = 1;
    assert_eq!(
        tiles.changed(&pixels, 130, 65).unwrap(),
        vec![Bounds {
            x: 128.0,
            y: 64.0,
            w: 2.0,
            h: 1.0
        }]
    );
    assert_eq!(tiles.changed(&[0; 3], 1, 1).unwrap().len(), 1);
    assert!(tiles.changed(&[], 1, 1).is_err());
    assert_eq!(
        tiles
            .changed(&vec![0; 3840 * 2160 * 3], 3840, 2160)
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn frame_pacing_keeps_the_final_change_and_sequence_continues_after_resume() {
    let mut stream = Stream::new("s".into(), 2, 10);
    assert!(stream.frame(&[0; 12], 2, 2, 1.0, 1000.0).unwrap().is_some());
    assert!(stream.frame(&[1; 12], 2, 2, 1.0, 1050.0).unwrap().is_none());
    assert_eq!(stream.due_in(1050.0), 50.0);
    assert!(stream.frame(&[1; 12], 2, 2, 1.0, 1100.0).unwrap().is_some());
    assert!(stream.frame(&[1; 12], 2, 2, 1.0, 1200.0).unwrap().is_none());
    stream.refresh();
    let packet = stream.frame(&[1; 12], 2, 2, 1.0, 1250.0).unwrap().unwrap();
    let length = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
    let header: Header = serde_json::from_slice(&packet[4..4 + length]).unwrap();
    assert_eq!(header.seq, 2);
}
struct App {
    reads: usize,
    offscreen: bool,
}
impl Source for App {
    type Element = usize;
    fn node(&mut self, e: &usize) -> ace_screen_helper_windows::errors::Result<Node> {
        self.reads += 1;
        Ok(Node {
            r#ref: format!("r{e}"),
            role: if *e == 0 { "window" } else { "button" }.into(),
            name: if *e == 2 {
                "Save".into()
            } else {
                "x".repeat(300)
            },
            value: None,
            description: None,
            bounds: Bounds::default(),
            states: if self.offscreen && *e == 1 {
                vec!["offscreen".into()]
            } else {
                vec![]
            },
            actions: vec!["press".into()],
            children: vec![],
        })
    }
    fn first_child(
        &mut self,
        e: &usize,
    ) -> ace_screen_helper_windows::errors::Result<Option<usize>> {
        Ok(if *e == 0 { Some(1) } else { None })
    }
    fn next_sibling(
        &mut self,
        e: &usize,
    ) -> ace_screen_helper_windows::errors::Result<Option<usize>> {
        Ok(if *e < 100 { Some(*e + 1) } else { None })
    }
}
#[test]
fn tree_caps_bound_provider_work_prune_offscreen_and_find_without_children() {
    let mut app = App {
        reads: 0,
        offscreen: true,
    };
    let tree = tree::walk(&mut app, 0, 8, 3).unwrap();
    assert!(tree.truncated);
    assert_eq!(app.reads, 3);
    let root = tree.root.as_ref().unwrap();
    assert_eq!(root.name.len(), 256);
    assert_eq!(root.children.len(), 1);
    assert_eq!(root.children[0].name, "Save");
    let found = tree::find(
        &tree,
        &Query {
            role: Some("BUTTON".into()),
            name: Some("sav".into()),
            text: None,
        },
        1,
    )
    .unwrap();
    assert_eq!(found[0].r#ref, "r2");
    assert!(found[0].children.is_empty());
    let depth = tree::walk(&mut app, 0, 0, 10).unwrap();
    assert!(depth.truncated);
    assert!(depth.root.unwrap().children.is_empty());
    assert!(tree::walk(&mut app, 0, 33, 10).is_err());
    assert!(tree::walk(&mut app, 0, 1, 2049).is_err());
    assert!(tree::find(
        &tree,
        &Query {
            role: None,
            name: None,
            text: None
        },
        129
    )
    .is_err());
}
#[test]
fn references_survive_refresh_but_never_alias_evicted_or_replaced_targets() {
    let mut refs = References::new(2);
    let a = refs.retain("A".into(), 1);
    let b = refs.retain("B".into(), 2);
    assert_eq!(refs.retain("A".into(), 3), a);
    let c = refs.retain("C".into(), 4);
    assert_eq!(refs.get(&a), Some(3));
    assert_eq!(refs.get(&b), None);
    assert_eq!(refs.get(&c), Some(4));
    refs.clear();
    let new = refs.retain("A".into(), 5);
    assert_ne!(a, new);
    assert_eq!(refs.get(&a), None);
}
#[test]
fn hresults_distinguish_stale_elements_uipi_timeouts_and_unsupported_patterns() {
    for (hr, code) in [
        (0x80070005u32, Code::PermissionDenied),
        (0x80040201, Code::TargetGone),
        (0x80004002, Code::NotSupported),
        (0x80070057, Code::Bounds),
        (0x800700AA, Code::Busy),
        (0x80131505, Code::Timeout),
        (0x80004005, Code::Internal),
    ] {
        assert_eq!(Error::hresult(hr as i32, "failure").code, code);
    }
}
#[test]
fn unicode_input_preserves_surrogates_and_drag_pairs_are_validated_before_injection() {
    use ace_screen_helper_windows::input::{plan, Action, Event};
    let mut action = Action::click(10.0, 20.0);
    action.kind = "text.type".into();
    action.text = Some("😀".into());
    assert_eq!(
        plan(&action).unwrap(),
        vec![
            Event::Key {
                code: 0,
                unit: 0xd83d,
                up: false,
                unicode: true,
                extended: false
            },
            Event::Key {
                code: 0,
                unit: 0xd83d,
                up: true,
                unicode: true,
                extended: false
            },
            Event::Key {
                code: 0,
                unit: 0xde00,
                up: false,
                unicode: true,
                extended: false
            },
            Event::Key {
                code: 0,
                unit: 0xde00,
                up: true,
                unicode: true,
                extended: false
            }
        ]
    );
    action.kind = "pointer.drag".into();
    assert!(plan(&action).is_err());
    action.to_x = Some(30.0);
    action.to_y = Some(40.0);
    assert_eq!(
        plan(&action).unwrap(),
        vec![
            Event::Move { x: 10.0, y: 20.0 },
            Event::Button {
                right: false,
                up: false
            },
            Event::Move { x: 30.0, y: 40.0 },
            Event::Button {
                right: false,
                up: true
            }
        ]
    );
    action.kind = "key.press".into();
    action.key = Some("ArrowLeft".into());
    action.modifiers = vec!["control".into()];
    assert_eq!(
        plan(&action).unwrap(),
        vec![
            Event::Key {
                code: 0x11,
                unit: 0,
                up: false,
                unicode: false,
                extended: false
            },
            Event::Key {
                code: 0x25,
                unit: 0,
                up: false,
                unicode: false,
                extended: true
            },
            Event::Key {
                code: 0x25,
                unit: 0,
                up: true,
                unicode: false,
                extended: true
            },
            Event::Key {
                code: 0x11,
                unit: 0,
                up: true,
                unicode: false,
                extended: false
            }
        ]
    );
    action.key = Some("unknown".into());
    assert!(plan(&action).is_err());
}
#[test]
fn finding_controls_stops_provider_work_at_the_result_limit() {
    let mut app = App {
        reads: 0,
        offscreen: false,
    };
    let found = tree::find_from(
        &mut app,
        0,
        &Query {
            role: Some("button".into()),
            name: None,
            text: None,
        },
        1,
    )
    .unwrap();
    assert_eq!(app.reads, 2);
    assert_eq!(found.nodes.len(), 1);
    assert!(found.nodes[0].children.is_empty());
    assert!(found.truncated);
}
#[test]
fn large_names_truncate_the_tree_before_the_reply_byte_cap() {
    struct Wide;
    impl Source for Wide {
        type Element = usize;
        fn node(&mut self, e: &usize) -> ace_screen_helper_windows::errors::Result<Node> {
            Ok(Node {
                r#ref: format!("r{e}"),
                role: "button".into(),
                name: "\0".repeat(256),
                value: Some("\0".repeat(256)),
                description: Some("\0".repeat(256)),
                bounds: Bounds::default(),
                states: vec![],
                actions: vec!["press".into()],
                children: vec![],
            })
        }
        fn first_child(
            &mut self,
            e: &usize,
        ) -> ace_screen_helper_windows::errors::Result<Option<usize>> {
            Ok((*e == 0).then_some(1))
        }
        fn next_sibling(
            &mut self,
            e: &usize,
        ) -> ace_screen_helper_windows::errors::Result<Option<usize>> {
            Ok((*e < 1000).then_some(e + 1))
        }
    }
    let tree = tree::walk(&mut Wide, 0, 8, 2048).unwrap();
    assert!(tree.truncated);
    assert!(!tree.root.as_ref().unwrap().children.is_empty());
    assert!(serde_json::to_vec(&tree).unwrap().len() < codec::MAX_REPLY - 1024);
}
#[test]
fn rounded_edge_points_stay_inside_the_target() {
    assert_eq!(mapping(144).physical(799.9, 0.0).unwrap(), (-721, 20));
}
#[test]
fn tree_strings_respect_utf16_caps_without_splitting_surrogate_pairs() {
    struct Emoji;
    impl Source for Emoji {
        type Element = ();
        fn node(&mut self, _: &()) -> ace_screen_helper_windows::errors::Result<Node> {
            Ok(Node {
                r#ref: "e".into(),
                role: "text".into(),
                name: "😀".repeat(300),
                value: None,
                description: None,
                bounds: Bounds::default(),
                states: vec![],
                actions: vec![],
                children: vec![],
            })
        }
        fn first_child(&mut self, _: &()) -> ace_screen_helper_windows::errors::Result<Option<()>> {
            Ok(None)
        }
        fn next_sibling(
            &mut self,
            _: &(),
        ) -> ace_screen_helper_windows::errors::Result<Option<()>> {
            Ok(None)
        }
    }
    let tree = tree::walk(&mut Emoji, (), 0, 1).unwrap();
    let name = tree.root.unwrap().name;
    assert_eq!(name, "😀".repeat(128));
}

#[test]
fn search_limits_use_utf16_units_and_accept_multibyte_queries() {
    let mut app = App {
        reads: 0,
        offscreen: false,
    };
    let mut tree = tree::walk(&mut app, 0, 0, 1).unwrap();
    tree.root.as_mut().unwrap().name = "😀".repeat(128);
    let query = Query {
        role: None,
        name: Some("😀".repeat(128)),
        text: None,
    };
    assert_eq!(tree::find(&tree, &query, 1).unwrap()[0].r#ref, "r0");
    let oversized = Query {
        role: None,
        name: Some("😀".repeat(129)),
        text: None,
    };
    assert_eq!(
        tree::find(&tree, &oversized, 1).unwrap_err().code,
        Code::Bounds
    );
    let before = app.reads;
    assert_eq!(
        tree::find_from(&mut app, 0, &oversized, 1)
            .unwrap_err()
            .code,
        Code::Bounds
    );
    assert_eq!(app.reads, before);
}

#[test]
fn unicode_error_messages_fit_the_shared_wire_limit_without_split_surrogates() {
    let error =
        ace_screen_helper_windows::errors::Error::hresult(0x80070005u32 as i32, "😀".repeat(1024));
    assert_eq!(error.code, Code::PermissionDenied);
    assert_eq!(error.message, "😀".repeat(512));
    assert_eq!(error.message.encode_utf16().count(), 1024);
}
