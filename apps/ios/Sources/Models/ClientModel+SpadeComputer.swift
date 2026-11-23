import Foundation

/// A bot's computer as the bridge draws it (`bridge/spade-computer-rows.ts`): who has it, whether
/// the person's input may go in on Spade's word, and the line under each surface.
struct SpadeComputerState: Decodable, Equatable, Sendable {
    struct Surface: Decodable, Equatable, Sendable {
        let kind: String
        let live: Bool
        let line: String?
        let url: String?
        let tabId: String?
        /// A tab in the person's own Chrome, which ace doesn't stream.
        let ownChrome: Bool
        let endingStuck: Bool
    }
    struct Drive: Decodable, Equatable, Sendable {
        let sentence: String
        /// The bot drives: its face moves beside the sentence.
        let face: Bool
        /// "take-over", "hand-back", or nil while neither uses it.
        let action: String?
    }
    let mayAct: Bool
    let driving: Bool
    let threadId: String?
    let waking: Bool
    let used: [String]
    let surfaces: [Surface]
    let drive: [String: Drive]
    func surface(_ kind: String) -> Surface? { surfaces.first { $0.kind == kind } }
}

struct SpadeFileEntry: Decodable, Hashable, Identifiable, Sendable {
    let name: String
    let path: String
    /// "folder", "file" or "link".
    let kind: String
    let size: Int
    var id: String { path }
    var isFolder: Bool { kind == "folder" }
}

struct SpadeFolder: Decodable, Equatable, Sendable {
    let path: String
    let entries: [SpadeFileEntry]
    let truncated: Bool
}

struct SpadeFile: Decodable, Equatable, Sendable {
    let path: String
    let size: Int
    let text: String?
    /// "binary" or "too_large" when Spade couldn't give it as text.
    let unreadable: String?
    let revision: String?
}

struct SpadeService: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let command: String
    let words: String
    let running: Bool
    let failed: Bool
    /// Ended, with none of its name running: Start runs its own command again.
    let startable: Bool
}

struct SpadeServiceLine: Decodable, Equatable, Sendable {
    let n: Int
    let text: String
}

/// Every answer about a bot's computer: `ok`, the words of a refusal, and what was asked for.
struct SpadeComputerReply: Decodable, Sendable {
    let ok: Bool
    let title: String?
    let message: String?
    /// A write the file's revision refused: the bot changed it since the person saw it.
    let changed: Bool?
    /// The file is gone: deleted or moved meanwhile.
    let gone: Bool?
    let computer: SpadeComputerState?
    let folder: SpadeFolder?
    let file: SpadeFile?
    let revision: String?
    let services: [SpadeService]?
    let lines: [SpadeServiceLine]?

    init(ok: Bool, title: String? = nil, message: String? = nil, computer: SpadeComputerState? = nil) {
        self.ok = ok; self.title = title; self.message = message; self.computer = computer
        changed = nil; gone = nil; folder = nil; file = nil; revision = nil; services = nil; lines = nil
    }
    /// Why it failed, in one line; nil when it went.
    var problem: String? {
        guard !ok else { return nil }
        return [title, message].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ". ")
    }
}

/// A bot's computer (`bridge/spade-computer.ts`, `bridge/spade-computer-live.ts`).
extension ClientModel {
    /// A request about a bot's computer; a transport failure reads as a refusal with its words.
    func spadeComputer(_ payload: [String: Any], failing title: String,
                       timeout: Duration = .seconds(30)) async -> SpadeComputerReply {
        do { return try await service(payload, as: SpadeComputerReply.self, timeout: timeout) }
        catch is CancellationError { return SpadeComputerReply(ok: false) }
        catch { return SpadeComputerReply(ok: false, title: title, message: error.localizedDescription) }
    }
    func spadeComputerRead(_ agent: String) async -> SpadeComputerReply {
        await spadeComputer(["type": "spade.computer", "agentId": agent], failing: "Couldn't read the computer")
    }
    /// Take over (the bot pauses until handed back), or hand back.
    func spadeComputerTake(_ agent: String, take: Bool) async -> SpadeComputerReply {
        await spadeComputer(["type": "spade.computer.take", "agentId": agent, "take": take],
                            failing: take ? "Couldn't take over" : "Couldn't hand back")
    }
    /// A file from the phone, staged, put in `folder`; large files take their time.
    func spadeUpload(_ agent: String, folder: String, file: StagedAttachment) async -> SpadeComputerReply {
        await spadeComputer(["type": "spade.files.upload", "agentId": agent, "folder": folder, "file": file.json],
                            failing: "Couldn't upload \(file.name)", timeout: .seconds(400))
    }
    /// A file's bytes, kept on this phone under its own name, for Quick Look and the share sheet.
    func spadeDownload(_ agent: String, path: String) async throws -> URL {
        let reply = try await service(["type": "spade.files.download", "agentId": agent, "path": path],
                                      as: AttachmentBytes.self, timeout: .seconds(120))
        guard let data = Data(base64Encoded: reply.data) else { throw ServiceFailure(message: "The file couldn't be decoded.") }
        return try MessageAttachmentRoutes.keep(data, named: reply.name)
    }
    /// Follow the bot's terminal under `stream`, the shared terminal model's id, or stop.
    func spadeTerminalWatch(_ agent: String, stream: String) {
        terminal.start(stream)
        action(["type": "spade.terminal.watch", "id": stream, "agentId": agent])
    }
    /// Stop following it, unless another terminal view has taken the shared model since.
    func spadeTerminalUnwatch(stream: String) {
        action(["type": "spade.terminal.unwatch", "id": stream])
        if terminal.streamId == stream { terminal.streamId = nil }
    }
}
