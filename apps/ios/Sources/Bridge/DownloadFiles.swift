import Foundation

/// Files the bridge saves to the phone a chunk at a time (`download.*`): a checkout file or a
/// folder's archive, written into the app's temporary directory as the bytes arrive so they never
/// pile up in JavaScript. Each download lives in its own folder named by the script's uuid, holding
/// one file under its display name. A chunk is appended only at the file's current length, so a
/// repeated or skipped chunk is refused instead of corrupting the file. Leftovers go with the
/// system's temporary-file cleanup. Runs on the host's serial storage queue.
struct DownloadFiles: Sendable {
    /// The most one append carries: a 64 KiB wire chunk as base64, with room to spare.
    static let chunkLimit = 128 * 1024
    var root = FileManager.default.temporaryDirectory.appendingPathComponent("ace-downloads", isDirectory: true)

    func perform(_ request: HostRequest) throws -> String? {
        switch request.operation {
        case "download.open":
            let open = try JSONDecoder().decode(Open.self, from: request.input)
            let folder = try self.folder(open.id)
            try? FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: folder.appendingPathComponent(Self.safe(open.name)).path, contents: nil) else { throw HostError.storage }
            return ""
        case "download.append":
            let append = try JSONDecoder().decode(Append.self, from: request.input)
            let body = try request.requireBody()
            guard body.utf8.count <= Self.chunkLimit, let data = Data(base64Encoded: body) else { throw HostError.unsupported }
            let handle = try FileHandle(forWritingTo: try file(append.id))
            defer { try? handle.close() }
            guard try handle.seekToEnd() == UInt64(append.offset) else { throw HostError.unsupported }
            try handle.write(contentsOf: data)
            return ""
        case "download.finish":
            return try file(try JSONDecoder().decode(Target.self, from: request.input).id).path
        case "download.discard":
            try? FileManager.default.removeItem(at: try folder(JSONDecoder().decode(Target.self, from: request.input).id))
            return ""
        default: return nil
        }
    }

    private func folder(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw HostError.unsupported }
        return root.appendingPathComponent(id.lowercased(), isDirectory: true)
    }
    /// The one file a download's folder holds.
    private func file(_ id: String) throws -> URL {
        let folder = try folder(id)
        guard let name = try FileManager.default.contentsOfDirectory(atPath: folder.path).first else { throw HostError.storage }
        return folder.appendingPathComponent(name)
    }
    /// A display name that stays one file name: no folders, no leading dot tricks, never empty.
    private static func safe(_ name: String) -> String {
        let cleaned = String(name.map { $0 == "/" || $0 == ":" || $0 == "\0" ? "_" : $0 }.prefix(255))
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "download" : cleaned
    }
}
private struct Open: Decodable { let id: String; let name: String }
private struct Append: Decodable { let id: String; let offset: Int }
private struct Target: Decodable { let id: String }
