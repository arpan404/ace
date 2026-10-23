import Foundation

/// A work log's rows and a turn's ending and changed files, as the bridge reads them from the
/// shared work-log reading (`bridge/work-log.ts`, `bridge/turn-ending.ts`).
extension BlockRow {
    /// One row of a work log: a lone step, a thought, a sentence group, or background commands.
    struct LogRow: Codable, Sendable, Equatable, Identifiable {
        /// `step`, `thought`, `group` or `background`.
        let kind: String
        let id: String
        var items: [String]? = nil
        /// A thought's header: "Thinking…", "Thought for 12s".
        var label: String? = nil
        var done: Bool? = nil
        /// A group's sentence: "Edited 2 files and ran 1 command".
        var sentence: String? = nil
        /// The sentence with its failures, for assistive tech.
        var summary: String? = nil
        var failed: Int? = nil
        var icon: String? = nil
        var running: Bool? = nil
        /// The group's step in flight, which titles it while the turn works.
        var active: String? = nil
        /// "2 steps", after a running group's title.
        var count: String? = nil
        /// Background commands that ended, and those still running, by call id.
        var listed: [String]? = nil
        var runningIds: [String]? = nil
    }
    /// A thought's header, by item.
    struct Thought: Codable, Sendable, Equatable {
        let id: String
        let label: String
        let done: Bool
    }
    /// An ace step worded with what earlier steps said about it.
    struct AceStep: Codable, Sendable, Equatable {
        let id: String
        let step: StepLine
    }
    /// How a turn that didn't simply complete ended.
    struct Ending: Codable, Sendable, Equatable {
        /// `failed`, `interrupted` or `paused`.
        let kind: String
        let automatic: Bool
        /// "Turn failed", "Interrupted by you", "Interrupted · after 3m", "Worked for 2m".
        let label: String
        /// After a failure's title: "Composer 2.5 · Cursor couldn't finish the request."
        let message: String
        /// The provider's own words, behind Details.
        let details: String
        /// The composer's strip says it (a usage or rate limit): no row in the transcript.
        let hidden: Bool
    }
    /// The files a turn changed, as chips.
    struct Files: Codable, Sendable, Equatable {
        struct Chip: Codable, Sendable, Equatable, Identifiable {
            let path: String
            let name: String
            let added: Int
            let removed: Int
            var id: String { path }
        }
        /// "Changed 3 files".
        let label: String
        let chips: [Chip]
        /// Files folded into "+N more".
        let more: Int
    }
}
