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
