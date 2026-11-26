// SPDX-License-Identifier: Apache-2.0
//! `recording-artifact.ts`: how a finished device recording is published, part by part, in
//! order: each part's artifact id, its file name and what a person sees. The renames, the
//! directory listing and the artifact registry are the shell's; written video is never deleted,
//! so a publication that fails says where the rest is.

/// One published part: the artifact's id, the file's name and the name a person sees.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Part {
    /// The part's place in the recording, as ace-media numbered it.
    pub index: u64,
    pub id: String,
    pub file: String,
    pub name: String,
}

/// The publication plan for `parts` (each part's ace-media index), in today's order: the first
/// keeps the recording's id, every later one is `<id>-<n>` and says "part n".
pub fn parts(id: &str, parts: &[u64]) -> Vec<Part> {
    let mut ordered = parts.to_vec();
    ordered.sort_unstable();
    ordered
        .iter()
        .enumerate()
        .map(|(place, index)| {
            let number = place + 1;
            let published = if place == 0 {
                id.to_string()
            } else {
                format!("{id}-{number}")
            };
            Part {
                index: *index,
                file: format!("{published}.mp4"),
                name: if place == 0 {
                    "Device recording.mp4".to_string()
                } else {
                    format!("Device recording (part {number}).mp4")
                },
                id: published,
            }
        })
        .collect()
}

/// Why a publication stopped: the video stays where ace-media wrote it and where the first part
/// was moved, and the message names both.
pub fn publish_failure(directory: &str, root: &str) -> String {
    format!("The recording couldn't be published: its video is kept in {directory} and {root}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_part_keeps_the_recordings_id_and_later_ones_say_their_part() {
        assert_eq!(
            parts("r1", &[0, 1]),
            vec![
                Part {
                    index: 0,
                    id: "r1".into(),
                    file: "r1.mp4".into(),
                    name: "Device recording.mp4".into(),
                },
                Part {
                    index: 1,
                    id: "r1-2".into(),
                    file: "r1-2.mp4".into(),
                    name: "Device recording (part 2).mp4".into(),
                },
            ]
        );
    }

    #[test]
    fn parts_are_published_in_the_order_ace_media_wrote_them() {
        let plan = parts("r1", &[2, 0, 1]);
        assert_eq!(
            plan.iter().map(|part| part.index).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(plan[2].file, "r1-3.mp4");
        assert_eq!(plan[2].name, "Device recording (part 3).mp4");
    }

    #[test]
    fn a_publication_that_stopped_names_both_places() {
        assert_eq!(
            publish_failure("/tmp/r1.parts", "/artifacts"),
            "The recording couldn't be published: its video is kept in /tmp/r1.parts and /artifacts"
        );
    }
}
