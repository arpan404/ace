import CryptoKit
import Foundation

/// Browser downloads copied onto this phone (`file.write`, `file.discard`, ADR 0096): the bridge
/// fetches a finished download from the machine and writes each chunk here as it arrives. The
/// bytes go to a partial file that becomes the named file only when the last chunk is written
/// (`done`), so a file the screen offers is always whole. Each download has its own folder named
/// by a hash of the machine and the bridge's id (thread and download), so ids from the machine
/// never become paths and two machines' or threads' downloads never share one. Copies live in
/// Caches and go with the system's cleanup.
struct SavedFiles: Sendable {
    /// The largest file the phone keeps (the bridge's `phoneDownloadMax`).
    static let maxBytes = 128 * 1024 * 1024
    var root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("ace-downloads", isDirectory: true)
    /// The machine whose downloads these are (its host id); "" outside a machine's runtime.
    var scope = ""

    /// Where `id`'s copy is once whole, named as the browser named it.
    func url(id: String, name: String) -> URL { folder(id).appendingPathComponent(Self.safeName(name)) }
    /// The copy, once it is whole on the phone.
    func file(id: String, name: String) -> URL? {
        let url = url(id: id, name: name)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Writes base64 `body` at `offset`: 0 starts the file again, any other offset must be where
    /// the partial file ends now, so a slice is never written twice or out of order. A file that
    /// would pass `maxBytes` is refused and deleted; `done` makes the partial file the named one.
    func write(id: String, name: String, offset: Int, base64 body: String, done: Bool) throws {
        guard let data = Data(base64Encoded: body), offset >= 0 else { throw HostError.unsupported }
        guard offset + data.count <= Self.maxBytes else {
            discard(id: id)
            throw HostError.storage
        }
        let manager = FileManager.default
        let partial = partialURL(id)
        try manager.createDirectory(at: partial.deletingLastPathComponent(), withIntermediateDirectories: true)
        if offset == 0 {
            // Starting again: an earlier copy, whole or partial, goes first.
            if let files = try? manager.contentsOfDirectory(at: folder(id), includingPropertiesForKeys: nil) {
                for file in files { try? manager.removeItem(at: file) }
            }
            try data.write(to: partial, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } else {
            let handle = try FileHandle(forWritingTo: partial)
            defer { try? handle.close() }
            guard try handle.seekToEnd() == UInt64(offset) else { throw HostError.storage }
            try handle.write(contentsOf: data)
        }
        if done { try manager.moveItem(at: partial, to: url(id: id, name: name)) }
    }

    /// The download's copy goes, whole or partial: a failed or cancelled save leaves nothing.
    func discard(id: String) {
        try? FileManager.default.removeItem(at: folder(id))
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

    private func folder(_ id: String) -> URL {
        let key = SHA256.hash(data: Data("\(scope)\u{0}\(id)".utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(key, isDirectory: true)
    }
    /// The bytes while they arrive; a leading dot keeps it apart from any safe name.
    private func partialURL(_ id: String) -> URL { folder(id).appendingPathComponent(".partial") }
}
