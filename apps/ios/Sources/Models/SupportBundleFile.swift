import Foundation

/// The support bundle on its way to the share sheet: written into a folder of its own under the
/// temporary directory, and removed once sharing ends or Diagnostics closes, so logs and settings
/// never linger on the phone.
enum SupportBundleFile {
    /// Writes `data` as `name` in a new folder under `root`; returns the file.
    static func write(_ data: Data, name: String, under root: URL = FileManager.default.temporaryDirectory) throws -> URL {
        let folder = root.appending(path: "ace-support-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: name)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        return file
    }
    /// Removes the bundle and its folder; nothing happens when it is already gone.
    static func discard(_ file: URL?) {
        guard let file else { return }
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }
}
