import Foundation

struct ThreadRow: Codable, Sendable, Identifiable, Equatable {
    struct Diff: Codable, Sendable, Equatable { let files: Int; let additions: Int; let deletions: Int }
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
    /// Whether this row is the daemon's current list (connected, caught up, confirmed,
    /// error-free). Nil on old payloads, which read as unconfirmed and never as done.
    var confirmed: Bool? = nil
    /// Confirmation fence: bumped only when confirmation is lost. Native keeps the newest
    /// generation it has seen and treats older confirmed rows as unconfirmed. Nil on old
    /// payloads, which never confirm.
    var generation: Int? = nil
    /// Inbox rows only: when the thread was archived, for the archive browser and read-only opens.
    var archivedAt: Double? = nil
    var workspaceId: String? = nil
    /// A chat with no project (ADR 0099): marked as a chat, left out of project filters.
    var chat: Bool? = nil
    var badge: String? = nil
    var diff: Diff? = nil
    var testsRunning: Bool? = nil
    /// The pull request the thread's card names, and whether it is still in review.
    var pr: PullRequestRef? = nil
    /// Start of the current working stretch (ms) while the tree works; nil otherwise.
    var workingSince: Double? = nil
    /// Inbox rows only: how loudly the row asks for the person (`inbox-look.ts`).
    var look: RowLook? = nil
    /// Inbox rows only: the account mark the provider glyph wears when its provider has several
    /// accounts (`inbox-accounts.ts`); nil draws the plain mark.
    var account: String? = nil
    /// Inbox rows only: pinned threads lead the list in `pinOrder` (higher first; nil for a pin
    /// from before places existed); `listOrder` is the place when the list is sorted by hand.
    var pinned: Bool? = nil
    var pinOrder: Double? = nil
    var listOrder: Double? = nil
    /// Inbox rows only: the group the thread's state puts it in ("snoozed", "settled"…), which
    /// a pinned row keeps while it shows under Pinned.
    var group: String? = nil
}
/// How an inbox row reads, by the web's Home row rule (`rowAttention`): the attention level,
/// the status word (none at rest: the row shows its age), its tone and glyph, and whether the
/// row mutes. Swift draws it; it never derives attention.
struct RowLook: Codable, Sendable, Equatable {
    let level: String
    let word: String?
    let tone: String
    let muted: Bool
    let glyph: String?
    /// Start (ms) of an active row's live stretch, for its elapsed time.
    let since: Double?
    let settled: Bool
    let subagents: Int
    /// The word takes its tone's colour unless the row mutes; waiting never does.
    var loud: Bool { !muted && tone != "waiting" }
}
struct PullRequestRef: Codable, Sendable, Equatable {
    let number: Int
    /// open, draft, merged or closed.
    let state: String
}
/// Drop `cut` UTF-8 bytes from the front of a text `base` bytes long, then add `append`. Bytes,
/// because Swift's strings count and slice them without transcoding.
struct TextEdit: Sendable, Equatable {
    let base: Int
    let cut: Int
    let append: String
    /// The edited text, or nil when `text` is not the one the edit was made against or the cut
    /// would split a character.
    func applied(to text: String) -> String? {
        guard text.utf8.count == base, let kept = String(text.utf8.dropFirst(cut)) else { return nil }
        return kept + append
    }
}

struct TranscriptRow: Codable, Sendable, Identifiable, Equatable {
    let id: String
    let index: Int?
    let type: String
    let role: String
    var text: String
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
    /// A context handoff's divider; nil on every other row.
    var handoff: HandoffLine? = nil
    /// The person's bubble as the web draws it; nil on every other row.
    var bubble: BubbleLine? = nil
    /// A thought's header: "Thinking…", "Thought for 12s"; nil on every other row.
    var thought: String? = nil
    /// Shared secondary line, such as the visualization fallback; empty when the row has none.
    let detail: String?
    let quiet: Bool?
}
/// The words inside the person's bubble (`@ace/ui-core` `bubbleContent`): prose, code and mention
/// runs in order, whether it folds behind "Show more", and how it was sent ("steer", "queue").
struct BubbleLine: Codable, Sendable, Equatable {
    struct Segment: Codable, Sendable, Equatable {
        /// "text", "code" or "mention".
        let kind: String
        let text: String
        /// A mention's catalog kind; empty for words and code.
        let mention: String
    }
    let segments: [Segment]
    let readable: Bool
    let long: Bool
    let origin: String
}
/// Where a thread moved to another provider (`@ace/ui-core` `handoffMarker`): the models whose
/// work carried over, oldest first, and the one taking the conversation.
struct HandoffLine: Codable, Sendable, Equatable {
    struct End: Codable, Sendable, Equatable { let provider: String; let model: String; let name: String }
    let label: String
    let from: [End]
    let to: End
    /// The whole marker as one sentence, for VoiceOver.
    let text: String
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
    /// Why it wasn't sent, behind Details, and the files on it; nil from older bridges.
    var detail: String? = nil; var files: Int? = nil
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
        /// Threads in the section, loaded or not: Settled counts the daemon's older pages too.
        var total: Int? = nil
        var id: String { key }
    }
    struct SnoozeOption: Codable, Sendable, Identifiable, Equatable { let id: String; let label: String }
    /// A choice of the machine's Sort threads setting, worded by the shared rules.
    struct SortOption: Codable, Sendable, Identifiable, Equatable { let id: String; let label: String }
    let sections: [Section]
    /// The daemon has older threads beyond the loaded window.
    let more: Bool
    let snooze: [SnoozeOption]
    /// The machine's `threads.sortBy` the sections are in, and the choices it offers; nil from
    /// older bridges.
    var sortBy: String? = nil
    var sorts: [SortOption]? = nil
    static let empty = InboxLayout(sections: [], more: false, snooze: [])
}

enum BridgePatch: Decodable, Sendable {
    case service(ServiceReply)
    case terminal(TerminalOutputPatch)
    case fragment(BridgeFragment)
    /// A new list: the ids of every row that follows (nil from older bridges, which clear all).
    case inboxReset([String]?)
    case inbox(String, ThreadRow?)
    case threadReset(String, Int)
    case position(String, Int, String, Int?)
    case item(String, Int, String, TranscriptRow?)
    /// Streaming text as an edit of the row shown (`bridge/text-edit.ts`): `row` carries
    /// every other field, its text empty until `ClientModel` applies the edit.
    case itemText(String, Int, String, TextEdit, TranscriptRow)
    case metadata(String, Int, ThreadRow?)
    case interaction(String, Int, String, ApprovalRow?)
    case cursor(String, Int, Int)
    case ready(String, Int, Int)
    case connection(String, Int?)
    case pending(String, PendingRow?)
    case error(String)
    case receipt(String, Bool, String)
    case admission(String, Bool, String)
    /// A message's full words for the edit sheet, or an edit's answer (`bridge/queued-words.ts`,
    /// `bridge/send-recovery.ts`): ok, the words when read, and why not when not.
    case words(String, Bool, String?, String)
    case block(String, Int, String, BlockRow?)
    case blockPosition(String, Int, String, Int?)
    case controls(String, Int, ControlsRow?)
    case history(String, Int, Bool)
    case models(String, Int, ThreadModels)
    case queue(String, Int, QueueRow)
    case inboxSections(InboxLayout)
    case problem(ProblemNotice?)
    case machineStatus(MachineStatusInfo)
    case machineProviders(MachineProvidersInfo)
    /// A project's mark, sent once per project (`bridge/project-looks.ts`); nil clears it.
    case projectLook(String, ProjectLookPatch?)
    /// The icon name of the mark this runtime's machine chose (`bridge/machine-identity.ts`).
    case machineIdentity(String)
    case notification(NotificationPatch)
    case agents(String, Int, AgentSheet)
    case changesSummary(String, Int, ChangesSummary)
    case changesFile(String, Int, String, FileDiff)
    case gitResult(String, Bool, String)
    case gitDraft(GitDraft)
    case archiveList(ArchiveList)
    /// New thread and Add project (`Models/ComposeModel.swift`); a thread's Files sheet.
    case compose(ComposePatch)
    /// The composer's `@`, `/` and + lists (`Models/ComposerSuggestions.swift`).
    case composer(ComposerSuggestPatch)
    case files(FilesPatch)
    /// Continue on… and Open on… (`bridge/transfers.ts`).
    case transfers(TransfersPatch)
    /// Steps, effort and speed, attachments and lanes (`ScreenPatch`).
    case screen(String, Int, ScreenPatch)
    /// The thread's live browser view (`bridge/browser-live.ts`).
    case browser(BrowserPatch)
    /// A thread's Devices screen and its logs (`bridge/native-devices.ts`).
    case devices(DevicesPatch)
    /// A kept read restored from an earlier run, and each family's generation (`bridge/native-reads.ts`).
    case serviceCache(ServiceReply.Cache, ServiceValue)
    /// A kept read the bridge stopped keeping: Swift's copy lets it go too.
    case serviceEvict(String)
    case serviceGenerations([String: Int])
    /// The history window put everything a read changed (`bridge/native-transcript.ts`).
    case readingSettled(String, Int)

    private enum Keys: String, CodingKey { case type, id, ids, row, base, cut, append, key, family, value, generations, threadId, epoch, state, message, ok, cursor, count, index, hasOlder, loading, models, problem, sheet, path, diff, generation, look, glyph, text }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        let type = try box.decode(String.self, forKey: .type)
        func scope() throws -> (String, Int) { (try box.decode(String.self, forKey: .threadId), try box.decode(Int.self, forKey: .epoch)) }
        switch type {
        case "service.reply": self = .service(try ServiceReply(from: decoder))
        case "service.cache":
            let cache = ServiceReply.Cache(key: try box.decode(String.self, forKey: .key), family: try box.decode(String.self, forKey: .family))
            self = .serviceCache(cache, try box.decode(ServiceValue.self, forKey: .value))
        case "service.evict": self = .serviceEvict(try box.decode(String.self, forKey: .key))
        case "service.generations": self = .serviceGenerations(try box.decode([String: Int].self, forKey: .generations))
        case "terminal.output": self = .terminal(try TerminalOutputPatch(from: decoder))
        case "fragment": self = .fragment(try BridgeFragment(from: decoder))
        case "inbox.reset": self = .inboxReset(try box.decodeIfPresent([String].self, forKey: .ids))
        case "inbox.row": self = .inbox(try box.decode(String.self, forKey: .id), try box.decodeIfPresent(ThreadRow.self, forKey: .row))
        case "thread.reset": let (id, epoch) = try scope(); self = .threadReset(id, epoch)
        case "thread.position":
            let (id, epoch) = try scope()
            self = .position(id, epoch, try box.decode(String.self, forKey: .id), try box.decodeIfPresent(Int.self, forKey: .index))
        case "thread.item":
            let (id, epoch) = try scope()
            self = .item(id, epoch, try box.decode(String.self, forKey: .id), try box.decodeIfPresent(TranscriptRow.self, forKey: .row))
        case "thread.item.text":
            let (id, epoch) = try scope()
            let edit = TextEdit(base: try box.decode(Int.self, forKey: .base), cut: try box.decode(Int.self, forKey: .cut),
                                append: try box.decode(String.self, forKey: .append))
            guard edit.cut >= 0, edit.cut <= edit.base else { throw DecodingError.dataCorruptedError(forKey: .cut, in: box, debugDescription: "cut past base") }
            self = .itemText(id, epoch, try box.decode(String.self, forKey: .id), edit, try box.decode(TranscriptRow.self, forKey: .row))
        case "thread.metadata": let (id, epoch) = try scope(); self = .metadata(id, epoch, try box.decodeIfPresent(ThreadRow.self, forKey: .row))
        case "thread.interaction":
            let (id, epoch) = try scope()
            self = .interaction(id, epoch, try box.decode(String.self, forKey: .id), try box.decodeIfPresent(ApprovalRow.self, forKey: .row))
        case "thread.cursor": let (id, epoch) = try scope(); self = .cursor(id, epoch, try box.decode(Int.self, forKey: .cursor))
        case "thread.ready": let (id, epoch) = try scope(); self = .ready(id, epoch, try box.decode(Int.self, forKey: .count))
        case "connection": self = .connection(try box.decode(String.self, forKey: .state), try box.decodeIfPresent(Int.self, forKey: .generation))
        case "pending": self = .pending(try box.decode(String.self, forKey: .id), try box.decodeIfPresent(PendingRow.self, forKey: .row))
        case "error": self = .error(try box.decode(String.self, forKey: .message))
        case "receipt": self = .receipt(try box.decode(String.self, forKey: .id), try box.decode(Bool.self, forKey: .ok), try box.decode(String.self, forKey: .message))
        case "words":
            let ok = try box.decode(Bool.self, forKey: .ok)
            self = .words(try box.decode(String.self, forKey: .id), ok, ok ? try box.decodeIfPresent(String.self, forKey: .text) : nil,
                          try box.decode(String.self, forKey: .message))
        case "admission": self = .admission(try box.decode(String.self, forKey: .id), try box.decode(Bool.self, forKey: .ok), try box.decode(String.self, forKey: .message))
        case "thread.block":
            let (id, epoch) = try scope()
            self = .block(id, epoch, try box.decode(String.self, forKey: .id), try box.decodeIfPresent(BlockRow.self, forKey: .row))
        case "thread.blockPosition":
            let (id, epoch) = try scope()
            self = .blockPosition(id, epoch, try box.decode(String.self, forKey: .id), try box.decodeIfPresent(Int.self, forKey: .index))
        case "reading.settled": let (id, epoch) = try scope(); self = .readingSettled(id, epoch)
        case "thread.controls": let (id, epoch) = try scope(); self = .controls(id, epoch, try box.decodeIfPresent(ControlsRow.self, forKey: .row))
        case "thread.history":
            let (id, epoch) = try scope()
            self = .history(id, epoch, try box.decode(Bool.self, forKey: .hasOlder))
        case "thread.queue": let (id, epoch) = try scope(); self = .queue(id, epoch, try QueueRow(from: decoder))
        case "thread.models":
            let (id, epoch) = try scope()
            self = .models(id, epoch, try ThreadModels(from: decoder))
        case "inbox.sections": self = .inboxSections(try InboxLayout(from: decoder))
        case "connection.problem": self = .problem(try box.decodeIfPresent(ProblemNotice.self, forKey: .problem))
        case "machine.status": self = .machineStatus(try MachineStatusInfo(from: decoder))
        case "machine.providers": self = .machineProviders(try MachineProvidersInfo(from: decoder))
        case "project.look":
            // A look that doesn't read draws the initials rather than failing the frame.
            self = .projectLook(try box.decode(String.self, forKey: .id), try? box.decodeIfPresent(ProjectLookPatch.self, forKey: .look))
        case "machine.identity": self = .machineIdentity(try box.decode(String.self, forKey: .glyph))
        case let kind where kind.hasPrefix("notifications."): self = .notification(try NotificationPatch(from: decoder))
        case let kind where kind.hasPrefix("compose."): self = .compose(try ComposePatch(from: decoder))
        case let kind where kind.hasPrefix("composer."): self = .composer(try ComposerSuggestPatch(from: decoder))
        case let kind where kind.hasPrefix("files."): self = .files(try FilesPatch(from: decoder))
        case let kind where kind.hasPrefix("transfers."): self = .transfers(try TransfersPatch(from: decoder))
        case "agents.sheet": let (id, epoch) = try scope(); self = .agents(id, epoch, try box.decode(AgentSheet.self, forKey: .sheet))
        case "changes.summary": let (id, epoch) = try scope(); self = .changesSummary(id, epoch, try ChangesSummary(from: decoder))
        case "changes.file":
            let (id, epoch) = try scope()
            self = .changesFile(id, epoch, try box.decode(String.self, forKey: .path), try box.decode(FileDiff.self, forKey: .diff))
        case "git.result": self = .gitResult(try box.decode(String.self, forKey: .id), try box.decode(Bool.self, forKey: .ok), try box.decode(String.self, forKey: .message))
        case "git.draft": self = .gitDraft(try GitDraft(from: decoder))
        case "archive.list": self = .archiveList(try ArchiveList(from: decoder))
        case let kind where BrowserPatch.types.contains(kind): self = .browser(try BrowserPatch(from: decoder))
        case let kind where DevicesPatch.types.contains(kind): self = .devices(try DevicesPatch(from: decoder))
        case let kind where ScreenPatch.types.contains(kind):
            let (id, epoch) = try scope()
            self = .screen(id, epoch, try ScreenPatch(type: kind, from: decoder))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: box, debugDescription: "Unknown bridge patch")
        }
    }
}
