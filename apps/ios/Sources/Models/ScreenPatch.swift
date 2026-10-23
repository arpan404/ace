import Foundation

/// A plan to approve as is or send back (`bridge/thread-requests.ts`).
struct PlanRequest: Codable, Sendable, Equatable {
    struct Todo: Codable, Sendable, Equatable { let text: String; let status: String }
    let title: String
    let summary: String
    let markdown: String
    let truncated: Bool
    let todos: [Todo]
}
/// An MCP server's form or consent page. Values travel as typed text; the bridge validates them.
struct FormRequest: Codable, Sendable, Equatable {
    struct Choice: Codable, Sendable, Equatable, Identifiable { let value: String; let label: String; var id: String { value } }
    struct Field: Codable, Sendable, Equatable, Identifiable {
        let key: String
        let title: String
        let detail: String
        let type: String
        let required: Bool
        let initial: String
        let choices: [Choice]
        let minimum: Double?
        let maximum: Double?
        var id: String { key }
    }
    let server: String
    let title: String
    let message: String
    let mode: String
    let url: String
    let unsupported: Bool
    let fields: [Field]
}
/// A browser tab on the agent's machine that needs the person.
struct HelpRequest: Codable, Sendable, Equatable { let title: String; let detail: String }

/// Effort and speed for the next message (`bridge/thread-tune.ts`).
struct TuneRow: Codable, Sendable, Equatable {
    struct Effort: Codable, Sendable, Equatable, Identifiable {
        let id: String
        let label: String
        /// The composer chip's name for it: "Med".
        var short: String? = nil
    }
    struct SpeedTier: Codable, Sendable, Equatable, Identifiable { let speed: String; let label: String; var id: String { speed } }
    let efforts: [Effort]
    let effort: String
    let effortDefault: Bool
    let effortReason: String
    let speeds: [SpeedTier]
    let speed: String
    let speedReason: String
    let pending: Bool
    let canReset: Bool
    let notice: String
}
/// A file on the next message, as the bridge's upload sees it.
struct AttachmentFile: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let kind: String
    let bytes: Int
    let state: String
    let progress: Double
    let error: String
}
/// The live pill over the composer (`bridge/thread-pill.ts`, worded by `livePill` in
/// `@ace/ui-core`): what the thread does now, and what else is live, each part naming the sheet it
/// opens (`agents`, `queue`, `goal`; empty opens nothing).
struct PillRow: Codable, Sendable, Equatable {
    struct Status: Codable, Sendable, Equatable {
        /// "Working", "Waiting on 2", "Running".
        let label: String
        /// The words before the timer, "Working for"; empty without a timer.
        let lead: String
        /// The timer's origin in ms since 1970.
        let since: Double?
        /// A single background command, drawn as code after the label; empty when none.
        let code: String
        /// The main agent itself works: the words sweep.
        let live: Bool
        /// `needs-you` while the tree waits on the person with no card here: drawn in that tone.
        let tone: String
        let opens: String
    }
    struct Segment: Codable, Sendable, Equatable, Identifiable {
        let kind: String
        let label: String
        let opens: String
        let live: Bool
        var id: String { kind }
    }
    let status: Status?
    let segments: [Segment]
}
/// The goal's sheet: its words, progress and the changes ace can make to it.
struct GoalRow: Codable, Sendable, Equatable {
    let title: String
    let objective: String
    /// "Not met yet: …"; empty when the provider gave no reason.
    let reason: String
    let usage: String
    let canPause: Bool
    let canResume: Bool
    let canClear: Bool
}
/// A finished turn's steps read from the daemon, page by page.
struct StepsHeader: Codable, Sendable, Equatable {
    let ordinal: Int
    let state: String
    let pages: Int
    let count: Int
    let more: Bool
    /// The turn's steps in groups, as the web's opened log groups them.
    var log: [BlockRow.LogRow]? = nil
    var aceSteps: [BlockRow.AceStep]? = nil
    var background: [BlockRow.Background]? = nil
    var retried: [String]? = nil
    var thoughts: [BlockRow.Thought]? = nil
}

/// The thread screen's patches beyond blocks and controls: finished steps, effort and speed,
/// attachments and a subagent's lane. Scoped to the thread and navigation generation like the rest.
enum ScreenPatch: Sendable {
    case steps(StepsHeader)
    case stepsPage(ordinal: Int, page: Int, rows: [TranscriptRow])
    case tune(TuneRow)
    case attachments([AttachmentFile])
    case laneBlock(lane: String, id: String, row: BlockRow?)
    case laneBlockPosition(lane: String, id: String, index: Int?)
    case pill(PillRow?, GoalRow?)

    static let types: Set<String> = ["thread.steps", "thread.stepsPage", "thread.tune", "thread.attachments", "thread.laneBlock", "thread.laneBlockPosition", "thread.pill"]
    private enum Keys: String, CodingKey { case type, ordinal, page, rows, files, lane, id, row, index, pill, goal }
    init(type: String, from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        switch type {
        case "thread.steps": self = .steps(try StepsHeader(from: decoder))
        case "thread.stepsPage":
            self = .stepsPage(ordinal: try box.decode(Int.self, forKey: .ordinal), page: try box.decode(Int.self, forKey: .page), rows: try box.decode([TranscriptRow].self, forKey: .rows))
        case "thread.tune": self = .tune(try TuneRow(from: decoder))
        case "thread.pill": self = .pill(try box.decodeIfPresent(PillRow.self, forKey: .pill), try box.decodeIfPresent(GoalRow.self, forKey: .goal))
        case "thread.attachments": self = .attachments(try box.decode([AttachmentFile].self, forKey: .files))
        case "thread.laneBlock":
            self = .laneBlock(lane: try box.decode(String.self, forKey: .lane), id: try box.decode(String.self, forKey: .id), row: try box.decodeIfPresent(BlockRow.self, forKey: .row))
        default:
            self = .laneBlockPosition(lane: try box.decode(String.self, forKey: .lane), id: try box.decode(String.self, forKey: .id), index: try box.decodeIfPresent(Int.self, forKey: .index))
        }
    }
}
