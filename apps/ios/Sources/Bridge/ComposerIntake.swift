import Foundation
import UIKit
import UniformTypeIdentifiers

/// Files arriving in the composer by paste, drag and drop, or a picked folder, copied and hashed
/// off the main actor into `AttachmentStaging`. A folder adds the files inside it, breadth first and
/// bounded as the web's folder drop is: hidden entries skipped, at most `folderFiles` files from at
/// most `folderVisits` entries, so a dropped `node_modules` costs a moment. Every check on what may
/// go (size, how many per message) stays the bridge's.
enum ComposerIntake {
    static let folderFiles = 50
    static let folderVisits = 2_000

    /// What arrived, and a note when a folder held more than was taken or nothing could be read.
    struct Result: Sendable { var files: [StagedAttachment] = []; var note: String? }

    /// Pasted or dropped items: images as images, anything with a file behind it as that file,
    /// folders walked. Plain text is the text field's own.
    static func stage(_ providers: [NSItemProvider], into staging: AttachmentStaging) async -> Result {
        var result = Result()
        var more = false
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.folder.identifier),
               let folder = await fileURL(provider, type: .folder) {
                let walked = Self.folder(folder, into: staging)
                try? FileManager.default.removeItem(at: folder)
                result.files += walked.files
                more = more || walked.note != nil
                continue
            }
            if let file = await stageFile(provider, into: staging) { result.files.append(file) }
        }
        if more { result.note = folderNote }
        else if result.files.isEmpty, !providers.isEmpty { result.note = "Couldn't read what was added." }
        return result
    }

    /// The files inside a folder the person picked or dropped.
    static func folder(_ url: URL, into staging: AttachmentStaging) -> Result {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        var result = Result()
        var queue = [url]
        var visited = 0
        var more = false
        let manager = FileManager.default
        walk: while !queue.isEmpty {
            let folder = queue.removeFirst()
            let children = (try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey],
                                                            options: [.skipsHiddenFiles])) ?? []
            for child in children.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                visited += 1
                if visited > folderVisits { more = true; break walk }
                let values = try? child.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey])
                if values?.isDirectory == true { queue.append(child); continue }
                guard values?.isRegularFile == true else { continue }
                if result.files.count == folderFiles { more = true; break walk }
                let type = UTType(filenameExtension: child.pathExtension)
                if let file = try? staging.stage(copying: child, name: child.lastPathComponent,
                                                 mimeType: type?.preferredMIMEType ?? "application/octet-stream") {
                    result.files.append(file)
                }
            }
        }
        if more { result.note = folderNote }
        else if result.files.isEmpty { result.note = "That folder has no files to attach." }
        return result
    }

    /// What a paste becomes.
    enum Paste: Equatable, Sendable {
        /// Short enough to go in as words.
        case words
        /// A text file on the message (`LargePaste`).
        case file(StagedAttachment)
        /// Why it can't go: past the file limit, or it couldn't be written.
        case refused(String)
    }
    /// One file's limit, the web's and the daemon's default (`@ace/ui-core` `attachmentLimits.fileBytes`),
    /// with the web's words for a file past it (`attachmentSizeProblem`).
    static let fileBytes = 512 * 1024 * 1024
    static let tooLarge = "Too large: files can be up to 512 MB each"
    /// The longest paste that can go back into the field as text: more makes the field unusable.
    static let restoreBytes = 1024 * 1024

    /// A paste, off the main actor: words when short, else the text file the web makes of it,
    /// written a slice at a time and hashed as `AttachmentStaging` streams it. Past `limit` it is
    /// refused before anything is written.
    @concurrent static func stage(paste text: String, into staging: AttachmentStaging, limit: Int = fileBytes) async -> Paste {
        guard let file = LargePaste.file(for: text) else { return .words }
        var text = text
        text.makeContiguousUTF8()
        guard text.utf8.count <= limit else { return .refused(tooLarge) }
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("ace-paste-\(UUID().uuidString)")
        do {
            guard FileManager.default.createFile(atPath: scratch.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
            let handle = try FileHandle(forWritingTo: scratch)
            defer { try? handle.close() }
            // A native string is one run of UTF-8 (`makeContiguousUTF8`): written from it, a slice at a time.
            let written: Void? = try text.utf8.withContiguousStorageIfAvailable { bytes in
                let slice = 256 * 1024
                var start = 0
                while start < bytes.count {
                    try handle.write(contentsOf: UnsafeRawBufferPointer(UnsafeBufferPointer(rebasing: bytes[start..<min(start + slice, bytes.count)])))
                    start += slice
                }
            }
            if written == nil { try handle.write(contentsOf: Data(text.utf8)) }
            try handle.close()
            return .file(try staging.stage(moving: scratch, name: file.name, mimeType: "text/plain"))
        } catch {
            try? FileManager.default.removeItem(at: scratch)
            return .refused("Couldn't attach the paste. Try again.")
        }
    }

    /// Whether a file on the message is a paste that can go back into the field as text: the
    /// phone made it (`LargePaste` name, not carried from another message), it is short enough
    /// for the field, and its staged copy is still here, whatever became of its upload.
    static func restorable(_ file: AttachmentFile, in staging: AttachmentStaging) -> Bool {
        file.carried == nil && LargePaste.isPasted(file.name) && file.bytes <= restoreBytes && staging.holds(file.id)
    }

    /// Why a paste the phone still holds can't go back as text, when that is its length; nil when
    /// it can, or when it isn't such a paste.
    static func staysAttached(_ file: AttachmentFile, in staging: AttachmentStaging) -> String? {
        guard file.carried == nil, LargePaste.isPasted(file.name), file.bytes > restoreBytes, staging.holds(file.id) else { return nil }
        return "Pastes over 1 MB stay as attachments"
    }

    /// A staged paste's words, read off the main actor, to put back in the message as text.
    @concurrent static func pastedText(_ localId: String, in staging: AttachmentStaging) async -> String? {
        guard let url = staging.file(localId), let data = try? Data(contentsOf: url) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static let folderNote = "Attached the first \(folderFiles) files. A folder adds up to \(folderFiles); hidden files are skipped."

    /// Whether a paste carries something other than words (an image, a file). Reads only the
    /// pasteboard's types, which never asks the person for paste permission.
    @MainActor static func pastesFiles(_ pasteboard: UIPasteboard = .general) -> Bool {
        if pasteboard.hasImages { return true }
        let types = pasteboard.types.compactMap { UTType($0) }
        let words = types.contains { $0.conforms(to: .text) || $0.conforms(to: .url) }
        return !words && types.contains { $0.conforms(to: .data) || $0.conforms(to: .folder) }
    }

    private static func stageFile(_ provider: NSItemProvider, into staging: AttachmentStaging) async -> StagedAttachment? {
        // An image the system holds only in memory (a screenshot copied from the markup sheet).
        if provider.canLoadObject(ofClass: UIImage.self), !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
           let type = provider.registeredContentTypes.first(where: { $0.conforms(to: .image) }) {
            if let url = await fileURL(provider, type: type) {
                let name = provider.suggestedName.map { "\($0).\(type.preferredFilenameExtension ?? "png")" } ?? "Pasted image.\(type.preferredFilenameExtension ?? "png")"
                return try? staging.stage(moving: url, name: name, mimeType: type.preferredMIMEType ?? "image/png")
            }
        }
        guard let type = provider.registeredContentTypes.first(where: { $0.conforms(to: .data) || $0.conforms(to: .content) }),
              let url = await fileURL(provider, type: type) else { return nil }
        let name = provider.suggestedName.map { name in
            name.contains(".") ? name : "\(name).\(type.preferredFilenameExtension ?? "")"
        } ?? url.lastPathComponent
        return try? staging.stage(moving: url, name: name, mimeType: type.preferredMIMEType ?? "application/octet-stream")
    }

    /// The provider's file, copied aside before its temporary file goes away.
    private static func fileURL(_ provider: NSItemProvider, type: UTType) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, _ in
                guard let url else { continuation.resume(returning: nil); return }
                let copy = FileManager.default.temporaryDirectory.appendingPathComponent("ace-intake-\(UUID().uuidString)", isDirectory: false)
                    .appendingPathExtension(url.pathExtension)
                do {
                    try FileManager.default.copyItem(at: url, to: copy)
                    continuation.resume(returning: copy)
                } catch { continuation.resume(returning: nil) }
            }
        }
    }
}
