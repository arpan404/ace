import CryptoKit
import Foundation

/// Browser downloads copied onto this phone (`file.write`, ADR 0096): the bridge fetches a
/// finished download from the machine and writes it here a slice at a time; the screen then
/// offers the file to share or save to Files. Each download has its own folder named by a hash
/// of its id, so ids from the machine never become paths. Copies live in Caches and go with the
/// system's cleanup.
struct SavedFiles: Sendable {
    var root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("ace-downloads", isDirectory: true)

    /// Where `id`'s copy is, named as the browser named it.
    func url(id: String, name: String) -> URL {
        let folder = SHA256.hash(data: Data(id.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(folder, isDirectory: true).appendingPathComponent(Self.safeName(name))
    }
    /// The copy, once it is whole on the phone.
    func file(id: String, name: String) -> URL? {
        let url = url(id: id, name: name)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Writes base64 `body` at `offset`: 0 starts the file again, any other offset must be where
    /// the file ends now, so a slice is never written twice or out of order.
    func write(id: String, name: String, offset: Int, base64 body: String) throws {
        guard let data = Data(base64Encoded: body), offset >= 0 else { throw HostError.unsupported }
        let target = url(id: id, name: name)
        let manager = FileManager.default
        try manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        if offset == 0 {
            try data.write(to: target, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return
        }
        let handle = try FileHandle(forWritingTo: target)
        defer { try? handle.close() }
        guard try handle.seekToEnd() == UInt64(offset) else { throw HostError.storage }
        try handle.write(contentsOf: data)
    }

    /// A browser's file name as a file name here: its last component, without leading dots or
    /// characters Files refuses; "download" when nothing is left.
    static func safeName(_ name: String) -> String {
        let last = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        var cleaned = last.filter { $0 != ":" && !$0.isNewline && $0 != "\0" }
        while cleaned.hasPrefix(".") { cleaned.removeFirst() }
        cleaned = String(cleaned.prefix(200)).trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty ? "download" : cleaned
    }
}
