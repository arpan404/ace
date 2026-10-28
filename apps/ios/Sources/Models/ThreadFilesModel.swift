import Foundation
import Observation

/// Whose files the Files screen shows: a thread's checkout, or (from New thread) a project's own
/// folder, which is read-only until a thread exists.
enum FilesScope: Hashable {
    case thread(String)
    case project(String)
    var wire: [String: String] {
        switch self {
        case .thread(let id): ["threadId": id]
        case .project(let id): ["workspaceId": id]
        }
    }
    /// Only a thread's checkout can be changed from the phone.
    var changes: Bool { if case .thread = self { true } else { false } }
}

/// A Files request the computer refused or couldn't answer, as the web's one sentence.
struct FilesFailure: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

/// The checkout as rows in tree order (`bridge/checkout-tree.ts`); folders end in "/".
struct FileTree: Decodable, Sendable {
    let rows: [FileTreeRow]
    /// Folders that start open: the ones holding an uncommitted change.
    let open: [String]
    /// The computer listed only the first 1,000 entries.
    let truncated: Bool
}
struct FileTreeRow: Decodable, Sendable, Identifiable, Hashable {
    let path: String
    let name: String
    let depth: Int
    let folder: Bool
    /// The web's git letter ("M", "A", "D", "R", "U") and its word.
    let mark: String?
    let markLabel: String?
    var id: String { path }
}
struct FileSearch: Decodable, Sendable {
    let query: String
    let rows: [FileSearchRow]
}
struct FileSearchRow: Decodable, Sendable, Identifiable, Hashable {
    let path: String
    let name: String
    let folder: String
    let isFolder: Bool
    /// UTF-16 offsets in `path` the query matched.
    let positions: [Int]
    var id: String { path }
}

/// A file as the file screen shows it: text (with the web's colours and change marks), an
/// image, or why it can't be shown.
struct FileContent: Decodable, Sendable {
    let kind: String
    let size: Int?
    let version: String?
    let text: String?
    /// An image's bytes, base64.
    let data: String?
    let markdown: Bool?
    let editable: Bool?
    /// Each colour as [light, dark] hex; run colour N is `colours[N - 1]`.
    let colours: [[String]]?
    /// Flat [length, colour, …] in UTF-16 units over the whole text.
    let runs: [Int]?
    let marks: [LineMark]?
}
/// A line changed since the last commit: "added", "modified" or "removed" (lines gone above it).
struct LineMark: Decodable, Sendable, Hashable {
    let line: Int
    let kind: String
    init(from decoder: any Decoder) throws {
        var pair = try decoder.unkeyedContainer()
        line = try pair.decode(Int.self)
        kind = try pair.decode(String.self)
    }
}
/// What a write or a change did: the new version, a conflict's newer version, or where it went.
struct FileChange: Decodable, Sendable {
    let path: String?
    let destination: String?
    let trashId: String?
    let version: String?
    let conflict: String?
}
struct TrashPage: Decodable, Sendable {
    let entries: [TrashEntry]
    let nextCursor: String?
}
struct TrashEntry: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let path: String
    let size: Int
    let expires: Double
}
/// Where a message's local link lands: "checkout" (a path and line), "linked" or "none".
struct FileLink: Decodable, Sendable {
    let kind: String
    let path: String?
    let line: Int?
    let name: String?
}
struct FileBytes: Decodable, Sendable {
    let name: String
    let data: String
}

/// A save to the phone in progress or done (`files.download`, `bridge/FILES-CONTRACT.md`).
struct FileDownload: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    /// `saving`, `saved`, `failed` or `stopped`.
    let phase: String
    let received: Int
    let size: Int?
    let filePath: String?
    let message: String?
}
/// Picked files going into a checkout folder (`files.upload`).
struct FileUpload: Decodable, Sendable, Equatable, Identifiable {
    struct Item: Decodable, Sendable, Equatable, Identifiable {
        let localId: String
        let name: String
        let path: String
        let size: Int
        let sent: Int
        /// `queued`, `sending`, `conflict`, `waiting`, `done`, `skipped`, `failed` or `stopped`.
        let state: String
        let message: String?
        var id: String { localId }
    }
    let id: String
    let threadId: String
    let folder: String
    /// `sending`, `asking`, `waiting`, `done`, `failed` or `stopped`.
    let phase: String
    let sent: Int
    let size: Int
    let items: [Item]
}
/// Recent and open files of one thread or project folder, kept on this phone.
struct FileMemory: Decodable, Sendable, Equatable {
    let key: String
    let recent: [String]
    let open: [String]
}
/// The quick-open answer: ranked matches, or with nothing typed, recent then changed files.
struct QuickOpen: Decodable, Sendable {
    struct Row: Decodable, Sendable, Identifiable, Hashable {
        let path: String
        let name: String
        let folder: String
        let isFolder: Bool
        let positions: [Int]
        let group: String
        var id: String { path }
        var search: FileSearchRow { FileSearchRow(path: path, name: name, folder: folder, isFolder: isFolder, positions: positions) }
    }
    let text: String
    let query: String
    let line: Int?
    let rows: [Row]
}
/// A folder's archive before it is saved (`archive` request).
struct ArchivePreview: Decodable, Sendable, Equatable {
    let previewId: String
    let entries: Int
    let bytes: Int
    let name: String
    let summary: String
    let leavesOut: String
}

/// Files screens read again when the computer says any checkout changed; saves, uploads and the
/// recent and open files arrive as their own patches.
enum FilesPatch: Decodable, Sendable {
    case changed(Int)
    case download(FileDownload)
    case upload(FileUpload)
    case memory(FileMemory)
    private enum Keys: String, CodingKey { case type, seq }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        switch try box.decode(String.self, forKey: .type) {
        case "files.changed": self = .changed(try box.decode(Int.self, forKey: .seq))
        case "files.download": self = .download(try FileDownload(from: decoder))
        case "files.upload": self = .upload(try FileUpload(from: decoder))
        case "files.memory": self = .memory(try FileMemory(from: decoder))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: box, debugDescription: "Unknown files patch")
        }
    }
}

/// How many times the computer said files changed (screens read again when it moves), and the
/// saves, uploads and remembered files the bridge reports.
@MainActor @Observable final class ThreadFilesModel {
    var revision = 0
    var downloads: [String: FileDownload] = [:]
    var uploads: [String: FileUpload] = [:]
    var memory: [String: FileMemory] = [:]
    func apply(_ patch: FilesPatch) {
        switch patch {
        case .changed(let seq): revision = seq
        case .download(let download): downloads[download.id] = download
        case .upload(let upload): uploads[upload.id] = upload
        case .memory(let memory): self.memory[memory.key] = memory
        }
    }
    func reset() { revision = 0; downloads = [:]; uploads = [:]; memory = [:] }
}

extension FilesScope {
    /// The key the bridge files this scope's recent and open files under.
    var memoryKey: String {
        switch self {
        case .thread(let id): "thread:\(id)"
        case .project(let id): "project:\(id)"
        }
    }
}

extension ClientModel {
    /// One Files request (`bridge/checkout-files.ts`); a refusal throws its sentence.
    func files<T: Decodable>(_ scope: FilesScope, _ operation: [String: Any], as type: T.Type) async throws -> T {
        let value = try await service(["type": "native.files", "scope": scope.wire, "operation": operation], as: ServiceValue.self)
        if case .object(let fields) = value, case .bool(false) = fields["ok"] {
            var code = "failed"
            var message = "Couldn't reach the files. Try again."
            if case .string(let text) = fields["code"] { code = text }
            if case .string(let text) = fields["message"] { message = text }
            throw FilesFailure(code: code, message: message)
        }
        return try value.decode(type)
    }
    /// A file's bytes written to a temporary folder under its own name, for Share or Quick Look.
    func fileCopy(_ scope: FilesScope, _ operation: [String: Any]) async throws -> URL {
        let bytes = try await files(scope, operation, as: FileBytes.self)
        guard let data = Data(base64Encoded: bytes.data) else { throw FilesFailure(code: "decode", message: "Couldn't read the file. Try again.") }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ace-files", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(bytes.name.isEmpty ? "file" : bytes.name)
        try data.write(to: url, options: .atomic)
        return url
    }
}
