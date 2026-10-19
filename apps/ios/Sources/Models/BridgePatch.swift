import Foundation

struct ThreadRow: Codable, Sendable, Identifiable, Equatable {
    let id: String
    let title: String
    let state: String
    let attention: String?
    let project: String
    let branch: String
    let machine: String
    let provider: String
    let model: String
    let agents: Int
    let snoozedUntil: Double?
    let updatedAt: Double
    let canSteer: Bool
    /// The shared status word and colour token (`@ace/ui-core/mobile`).
    let status: StatusDisplay
    /// Inbox rows only: the machine the thread runs on and its last execution activity.
    let machineId: String?
    let activityAt: Double?
    /// Inbox rows only: when the thread was archived, for the archive browser and read-only opens.
    var archivedAt: Double? = nil
}
struct TranscriptRow: Codable, Sendable, Identifiable, Equatable {
    let id: String
    let index: Int?
    let type: String
    let role: String
    let text: String
    let complete: Bool
    let createdAt: Double
    let agentId: String
    let truncated: Bool
    var runId: String? = nil
    var synthetic: Bool? = nil
    var level: String? = nil
    var step: StepLine? = nil
    var attachments: [AttachmentLine]? = nil
    var moreAttachments: Int? = nil
    /// Shared secondary line, such as the visualization fallback; empty when the row has none.
    let detail: String?
    let quiet: Bool?
}
struct ApprovalRow: Codable, Sendable, Identifiable {
    struct Option: Codable, Sendable, Identifiable { let id: String; let label: String; let kind: String }
    let id: String
    let kind: String
    let state: String
    let title: String
    let description: String
    let command: String
    let options: [Option]
    let truncated: Bool
    var heading: String? = nil
    var reason: String? = nil
    var risk: String? = nil
    var riskText: String? = nil
    var decisions: [Decision]? = nil
    var others: [Other]? = nil
    var questions: [Question]? = nil
    var unanswerable: Bool? = nil
    var plan: PlanRequest? = nil
    var form: FormRequest? = nil
    var help: HelpRequest? = nil
}
struct PendingRow: Codable, Sendable, Identifiable {
    let id: String; let threadId: String; let state: String; let waiting: Bool; let text: String
    /// The shared unsent wording ("Sends on reconnect", "Not sent") and its colour token.
    let label: String?; let token: String?
}
/// A status the bridge has already worded; Swift only maps `token` to a theme colour.
struct StatusDisplay: Codable, Sendable, Equatable { let label: String; let token: String }
/// The shared inbox grouping: ordered sections of row ids (thread ids, or pending ids for Unsent).
struct InboxLayout: Codable, Sendable, Equatable {
    struct Section: Codable, Sendable, Identifiable, Equatable {
        let key: String; let label: String; let ids: [String]
        /// The shared rank of each row, parallel to `ids`, and the section's place among groups:
        /// `MergedInbox` orders every machine's sections by them.
        var ranks: [String]? = nil
        var order: Int? = nil
        var id: String { key }
    }
    struct SnoozeOption: Codable, Sendable, Identifiable, Equatable { let id: String; let label: String }
    let sections: [Section]
    /// The daemon has older threads beyond the loaded window.
    let more: Bool
    let snooze: [SnoozeOption]
    static let empty = InboxLayout(sections: [], more: false, snooze: [])
}

enum BridgePatch: Decodable, Sendable {
    case fragment(BridgeFragment)
    case inboxReset
    case inbox(String, ThreadRow?)
    case threadReset(String, Int)
    case position(String, Int, String, Int?)
    case item(String, Int, String, TranscriptRow?)
    case metadata(String, Int, ThreadRow?)
    case interaction(String, Int, String, ApprovalRow?)
    case cursor(String, Int, Int)
    case ready(String, Int, Int)
    case connection(String)
    case pending(String, PendingRow?)
    case error(String)
    case receipt(String, Bool, String)
    case admission(String, Bool, String)
    case block(String, Int, String, BlockRow?)
    case blockPosition(String, Int, String, Int?)
    case controls(String, Int, ControlsRow?)
    case history(String, Int, Bool, Bool)
    case models(String, Int, String, [ModelOption])
    case queue(String, Int, QueueRow)
    case inboxSections(InboxLayout)
    case problem(ProblemNotice?)
    case machineStatus(MachineStatusInfo)
    case machineProviders(MachineProvidersInfo)
    case notification(NotificationPatch)
    case agents(String, Int, AgentSheet)
    case changesSummary(String, Int, ChangesSummary)
    case changesFile(String, Int, String, FileDiff)
    case gitResult(String, Bool, String)
    case gitDraft(GitDraft)
    case archiveList(ArchiveList)
    /// New thread and Add project (`Models/ComposeModel.swift`); a thread's Files sheet.
    case compose(ComposePatch)
    case files(FilesPatch)
    /// Steps, effort and speed, attachments and lanes (`ScreenPatch`).
    case screen(String, Int, ScreenPatch)

    private enum Keys: String, CodingKey { case type, id, row, threadId, epoch, state, message, ok, cursor, count, index, hasOlder, loading, models, problem, sheet, path, diff }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        let type = try box.decode(String.self, forKey: .type)
        func scope() throws -> (String, Int) { (try box.decode(String.self, forKey: .threadId), try box.decode(Int.self, forKey: .epoch)) }
        switch type {
        case "fragment": self = .fragment(try BridgeFragment(from: decoder))
        case "inbox.reset": self = .inboxReset
        case "inbox.row": self = .inbox(try box.decode(String.self, forKey: .id), try box.decodeIfPresent(ThreadRow.self, forKey: .row))
        case "thread.reset": let (id, epoch) = try scope(); self = .threadReset(id, epoch)
        case "thread.position":
            let (id, epoch) = try scope()
            self = .position(id, epoch, try box.decode(String.self, forKey: .id), try box.decodeIfPresent(Int.self, forKey: .index))
        case "thread.item":
            let (id, epoch) = try scope()
            self = .item(id, epoch, try box.decode(String.self, forKey: .id), try box.decodeIfPresent(TranscriptRow.self, forKey: .row))
        case "thread.metadata": let (id, epoch) = try scope(); self = .metadata(id, epoch, try box.decodeIfPresent(ThreadRow.self, forKey: .row))
        case "thread.interaction":
            let (id, epoch) = try scope()
            self = .interaction(id, epoch, try box.decode(String.self, forKey: .id), try box.decodeIfPresent(ApprovalRow.self, forKey: .row))
        case "thread.cursor": let (id, epoch) = try scope(); self = .cursor(id, epoch, try box.decode(Int.self, forKey: .cursor))
        case "thread.ready": let (id, epoch) = try scope(); self = .ready(id, epoch, try box.decode(Int.self, forKey: .count))
        case "connection": self = .connection(try box.decode(String.self, forKey: .state))
        case "pending": self = .pending(try box.decode(String.self, forKey: .id), try box.decodeIfPresent(PendingRow.self, forKey: .row))
        case "error": self = .error(try box.decode(String.self, forKey: .message))
        case "receipt": self = .receipt(try box.decode(String.self, forKey: .id), try box.decode(Bool.self, forKey: .ok), try box.decode(String.self, forKey: .message))
        case "admission": self = .admission(try box.decode(String.self, forKey: .id), try box.decode(Bool.self, forKey: .ok), try box.decode(String.self, forKey: .message))
        case "thread.block":
            let (id, epoch) = try scope()
            self = .block(id, epoch, try box.decode(String.self, forKey: .id), try box.decodeIfPresent(BlockRow.self, forKey: .row))
        case "thread.blockPosition":
            let (id, epoch) = try scope()
            self = .blockPosition(id, epoch, try box.decode(String.self, forKey: .id), try box.decodeIfPresent(Int.self, forKey: .index))
        case "thread.controls": let (id, epoch) = try scope(); self = .controls(id, epoch, try box.decodeIfPresent(ControlsRow.self, forKey: .row))
        case "thread.history":
            let (id, epoch) = try scope()
            self = .history(id, epoch, try box.decode(Bool.self, forKey: .hasOlder), try box.decode(Bool.self, forKey: .loading))
        case "thread.queue": let (id, epoch) = try scope(); self = .queue(id, epoch, try QueueRow(from: decoder))
        case "thread.models":
            let (id, epoch) = try scope()
            self = .models(id, epoch, try box.decode(String.self, forKey: .state), try box.decode([ModelOption].self, forKey: .models))
        case "inbox.sections": self = .inboxSections(try InboxLayout(from: decoder))
        case "connection.problem": self = .problem(try box.decodeIfPresent(ProblemNotice.self, forKey: .problem))
        case "machine.status": self = .machineStatus(try MachineStatusInfo(from: decoder))
        case "machine.providers": self = .machineProviders(try MachineProvidersInfo(from: decoder))
        case let kind where kind.hasPrefix("notifications."): self = .notification(try NotificationPatch(from: decoder))
        case let kind where kind.hasPrefix("compose."): self = .compose(try ComposePatch(from: decoder))
        case let kind where kind.hasPrefix("files."): self = .files(try FilesPatch(from: decoder))
        case "agents.sheet": let (id, epoch) = try scope(); self = .agents(id, epoch, try box.decode(AgentSheet.self, forKey: .sheet))
        case "changes.summary": let (id, epoch) = try scope(); self = .changesSummary(id, epoch, try ChangesSummary(from: decoder))
        case "changes.file":
            let (id, epoch) = try scope()
            self = .changesFile(id, epoch, try box.decode(String.self, forKey: .path), try box.decode(FileDiff.self, forKey: .diff))
        case "git.result": self = .gitResult(try box.decode(String.self, forKey: .id), try box.decode(Bool.self, forKey: .ok), try box.decode(String.self, forKey: .message))
        case "git.draft": self = .gitDraft(try GitDraft(from: decoder))
        case "archive.list": self = .archiveList(try ArchiveList(from: decoder))
        case let kind where ScreenPatch.types.contains(kind):
            let (id, epoch) = try scope()
            self = .screen(id, epoch, try ScreenPatch(type: kind, from: decoder))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: box, debugDescription: "Unknown bridge patch")
        }
    }
}
