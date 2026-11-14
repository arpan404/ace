// SPDX-License-Identifier: Apache-2.0
// Independent, bounds-checked test reader. It imports no writer helpers.
#![allow(dead_code)]
#![allow(clippy::unwrap_used)]
#[derive(Debug)]
pub struct BoxRef<'a> {
    pub kind: &'a [u8],
    pub body: &'a [u8],
    pub offset: usize,
    pub size: usize,
}
pub fn u32at(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
}
pub fn u64at(b: &[u8], at: usize) -> u64 {
    u64::from_be_bytes(b[at..at + 8].try_into().unwrap())
}
pub fn boxes(b: &[u8]) -> Vec<BoxRef<'_>> {
    let mut out = Vec::new();
    let mut offset = 0;
    while let Some(header) = b.get(offset..offset + 8) {
        let size = u32at(header, 0) as usize;
        if size < 8 {
            break;
        }
        let Some(body) = b.get(offset + 8..offset + size) else {
            break;
        };
        out.push(BoxRef {
            kind: &header[4..],
            body,
            offset,
            size,
        });
        offset += size;
    }
    out
}
pub fn child<'a>(b: &'a [u8], kind: &[u8]) -> &'a [u8] {
    boxes(b).into_iter().find(|b| b.kind == kind).unwrap().body
}
#[derive(Debug, PartialEq)]
pub struct Run {
    pub id: u32,
    pub time: u64,
    pub durations: Vec<u32>,
    pub flags: Vec<u32>,
    pub payloads: Vec<Vec<u8>>,
}
pub fn runs(fragment: &[u8]) -> Vec<Run> {
    let top = boxes(fragment);
    assert_eq!(top.len(), 2);
    assert_eq!(top[0].kind, b"moof");
    assert_eq!(top[1].kind, b"mdat");
    boxes(top[0].body)
        .iter()
        .filter(|b| b.kind == b"traf")
        .map(|t| {
            let h = child(t.body, b"tfhd");
            assert_eq!(u32at(h, 0), 0x20000);
            let dt = child(t.body, b"tfdt");
            assert_eq!(dt[0], 1);
            let tr = child(t.body, b"trun");
            assert_eq!(u32at(tr, 0), 0x701);
            let mut at = u32at(tr, 8) as usize;
            let mut run = Run {
                id: u32at(h, 4),
                time: u64at(dt, 4),
                durations: vec![],
                flags: vec![],
                payloads: vec![],
            };
            for i in 0..u32at(tr, 4) as usize {
                let row = 12 + i * 12;
                let len = u32at(tr, row + 4) as usize;
                assert!(at >= top[1].offset + 8 && at + len <= top[1].offset + top[1].size);
                run.durations.push(u32at(tr, row));
                run.flags.push(u32at(tr, row + 8));
                run.payloads.push(fragment[at..at + len].to_vec());
                at += len;
            }
            run
        })
        .collect()
}
/// Only complete moof+mdat pairs count as committed fragments.
pub fn committed(file: &[u8]) -> usize {
    boxes(file)
        .windows(2)
        .filter(|p| p[0].kind == b"moof" && p[1].kind == b"mdat")
        .count()
}
