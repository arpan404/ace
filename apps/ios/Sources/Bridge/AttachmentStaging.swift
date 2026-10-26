import CryptoKit
import Foundation

/// A picked photo or file, copied where the bridge can read it back a chunk at a time.
struct StagedAttachment: Sendable, Equatable {
    let localId: String
    let name: String
    let mimeType: String
    let bytes: Int
    let sha256: String
    var json: [String: Any] { ["localId": localId, "name": name, "mimeType": mimeType, "bytes": bytes, "sha256": sha256] }
}

/// Files staged for the next message. A picked file is copied into the app's own temporary
/// directory under a random id and hashed as it streams; the bridge pulls at most one 48 KiB chunk
/// at a time (`attachment.chunk`), so a large file never sits in JavaScript whole. Staged copies
/// go when removed from the message, or with the system's temporary-file cleanup. New thread's
/// first-message files stage in the draft's own folder instead (`NewThreadDraftStore.files`), so
/// they survive a relaunch until the start is saved or they are discarded.
struct AttachmentStaging: Sendable {
    static let chunkLimit = 48 * 1024
    var root = FileManager.default.temporaryDirectory.appendingPathComponent("ace-attachments", isDirectory: true)

    func stage(copying source: URL, name: String, mimeType: String) throws -> StagedAttachment {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let localId = UUID().uuidString.lowercased()
        let target = url(localId)
        try FileManager.default.copyItem(at: source, to: target)
        return try staged(localId, name: name, mimeType: mimeType)
    }
    func stage(data: Data, name: String, mimeType: String) throws -> StagedAttachment {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let localId = UUID().uuidString.lowercased()
        try data.write(to: url(localId), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return try staged(localId, name: name, mimeType: mimeType)
    }
    /// One chunk of a staged file as base64, for the bridge's upload.
    func chunk(_ localId: String, offset: Int, limit: Int) throws -> String {
        guard valid(localId), offset >= 0, limit > 0, limit <= Self.chunkLimit else { throw HostError.unsupported }
        let handle = try FileHandle(forReadingFrom: url(localId))
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        return (try handle.read(upToCount: limit) ?? Data()).base64EncodedString()
    }
    func discard(_ localId: String) {
        guard valid(localId) else { return }
        try? FileManager.default.removeItem(at: url(localId))
    }
    /// Whether a staged copy is still here to read.
    func holds(_ localId: String) -> Bool { valid(localId) && FileManager.default.fileExists(atPath: url(localId).path) }
    /// The staged copy itself, for drawing it on the phone; nil once it is gone.
    func file(_ localId: String) -> URL? { holds(localId) ? url(localId) : nil }
    /// Removes every staged copy but `keeping`.
    func sweep(keeping: Set<String>) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        for name in names where !keeping.contains(name) { try? FileManager.default.removeItem(at: root.appendingPathComponent(name)) }
    }

    private func url(_ localId: String) -> URL { root.appendingPathComponent(localId) }
    private func valid(_ localId: String) -> Bool { UUID(uuidString: localId) != nil }
    private func staged(_ localId: String, name: String, mimeType: String) throws -> StagedAttachment {
        let handle = try FileHandle(forReadingFrom: url(localId))
        defer { try? handle.close() }
        var hash = SHA256()
        var bytes = 0
        while let data = try handle.read(upToCount: 256 * 1024), !data.isEmpty {
            hash.update(data: data)
            bytes += data.count
        }
        let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        let trimmed = String(name.prefix(255))
        return StagedAttachment(localId: localId, name: trimmed.isEmpty ? "file" : trimmed, mimeType: String(mimeType.prefix(128)), bytes: bytes, sha256: digest)
    }
}
