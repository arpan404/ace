import Foundation
import Observation

/// One sentence about a transfer with its text buttons (`bridge/transfer-lines.ts`): "Sending to
/// Studio · 312 MB of 1.2 GB  Cancel", "Continued on Studio  Open".
struct TransferLineRow: Codable, Equatable, Sendable {
    struct Action: Codable, Equatable, Sendable, Identifiable {
        /// `cancel`, `retry` and `dismiss` go back to the bridge; `open` routes here.
        let act: String
        let label: String
        let disabled: Bool
        var id: String { act }
    }
    /// Where Open goes: that machine's thread (or project).
    struct Target: Codable, Equatable, Sendable { let hostId: String; let threadId: String?; let workspaceId: String? }
    let transferId: String?
    let words: String
    /// Failed or refused: VoiceOver reads it out. Never tinted.
    let alert: Bool
    let actions: [Action]
    let open: Target?
}

/// A machine this one has a fleet link to; `reason` ("Offline", "Projects not allowed") when it
/// can't take work now.
struct TransferMachineRow: Codable, Equatable, Sendable, Identifiable {
    let hostId: String
    let name: String
    let reason: String?
    var id: String { hostId }
}

/// The Continue on / Open on sheet as the bridge walks it (`bridge/transfer-sheet.ts`).
struct TransferSheetState: Decodable, Equatable, Sendable {
    struct Machine: Codable, Equatable, Sendable { let hostId: String; let name: String }
    enum Step: Equatable, Sendable {
        case checking(String)
        case machines([TransferMachineRow], empty: String?)
        case options(Machine, action: String, ignoredByDefault: Bool)
        case status(Machine, action: String, line: TransferLineRow)
    }
    /// `thread` or `project`.
    let kind: String
    let title: String
    /// The thread's title or the project's name.
    let what: String
    let step: Step

    private enum Keys: String, CodingKey { case kind, title, what, step }
    private enum StepKeys: String, CodingKey { case kind, words, machines, empty, machine, action, ignoredByDefault, line }
    init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        kind = try box.decode(String.self, forKey: .kind)
        title = try box.decode(String.self, forKey: .title)
        what = try box.decode(String.self, forKey: .what)
        let step = try box.nestedContainer(keyedBy: StepKeys.self, forKey: .step)
        switch try step.decode(String.self, forKey: .kind) {
        case "checking": self.step = .checking(try step.decode(String.self, forKey: .words))
        case "machines":
            self.step = .machines(try step.decode([TransferMachineRow].self, forKey: .machines), empty: try step.decodeIfPresent(String.self, forKey: .empty))
        case "options":
            self.step = .options(try step.decode(Machine.self, forKey: .machine), action: try step.decode(String.self, forKey: .action),
                                 ignoredByDefault: try step.decode(Bool.self, forKey: .ignoredByDefault))
        case "status":
            self.step = .status(try step.decode(Machine.self, forKey: .machine), action: try step.decode(String.self, forKey: .action),
                                line: try step.decode(TransferLineRow.self, forKey: .line))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: step, debugDescription: "Unknown transfer step")
        }
    }
}

/// The open thread's transfer: whether it can be continued now, and its line above the composer.
struct TransferThreadState: Codable, Equatable, Sendable {
    let threadId: String
    let epoch: Int
    let canContinue: Bool
    let line: TransferLineRow?
}

/// `transfers.machines`, `transfers.sheet` and `transfers.thread` (`bridge/transfers.ts`).
enum TransfersPatch: Decodable, Sendable {
    case machines(state: String, machines: [TransferMachineRow], ignoredByDefault: Bool)
    case sheet(TransferSheetState?)
    case thread(TransferThreadState?)
    private enum Keys: String, CodingKey { case type, state, machines, ignoredByDefault, sheet, thread }
    init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        switch try box.decode(String.self, forKey: .type) {
        case "transfers.machines":
            self = .machines(state: try box.decode(String.self, forKey: .state), machines: try box.decode([TransferMachineRow].self, forKey: .machines),
                             ignoredByDefault: try box.decode(Bool.self, forKey: .ignoredByDefault))
        case "transfers.sheet": self = .sheet(try box.decodeIfPresent(TransferSheetState.self, forKey: .sheet))
        case "transfers.thread": self = .thread(try box.decodeIfPresent(TransferThreadState.self, forKey: .thread))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: box, debugDescription: "Unknown transfers patch")
        }
    }
}

/// This machine's side of Continue on… and Open on…: the machines it links to, the sheet while
/// it shows, and the open thread's line.
@MainActor @Observable final class TransfersModel {
    private(set) var machines: [TransferMachineRow] = []
    private(set) var ignoredByDefault = true
    private(set) var sheet: TransferSheetState?
    private(set) var thread: TransferThreadState?
    /// Nothing about transfers shows until this machine is linked to another.
    var linked: Bool { !machines.isEmpty }
    func apply(_ patch: TransfersPatch) {
        switch patch {
        case .machines(_, let machines, let ignored):
            if self.machines != machines { self.machines = machines }
            ignoredByDefault = ignored
        case .sheet(let sheet): if self.sheet != sheet { self.sheet = sheet }
        case .thread(let thread): if self.thread != thread { self.thread = thread }
        }
    }
    /// The open thread's state, when it is this thread's.
    func thread(_ id: String) -> TransferThreadState? { thread?.threadId == id ? thread : nil }
    func reset() { machines = []; sheet = nil; thread = nil; ignoredByDefault = true }
}
