import CoreTransferable
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// One item picked in Photos, staged for the message: a video as its file, copied and hashed
/// without ever being held in memory, and a picture (a live photo as its still) in a type the
/// agent reads (`PhotoConversion`). Every check on what can go is the bridge's.
enum PhotoLibraryPick {
    enum Failure: Error { case unreadable }

    static func stage(_ item: PhotosPickerItem, into staging: AttachmentStaging) async throws -> StagedAttachment {
        if let movie = item.supportedContentTypes.first(where: { $0.conforms(to: .movie) }) {
            guard let picked = try await item.loadTransferable(type: PickedMovie.self) else { throw Failure.unreadable }
            let name = "Video.\(picked.url.pathExtension.isEmpty ? (movie.preferredFilenameExtension ?? "mov") : picked.url.pathExtension)"
            let mime = movie.preferredMIMEType ?? "video/quicktime"
            return try await Task.detached(priority: .userInitiated) {
                try staging.stage(moving: picked.url, name: name, mimeType: mime)
            }.value
        }
        let type = item.supportedContentTypes.first { $0.conforms(to: .image) } ?? .jpeg
        guard let data = try await item.loadTransferable(type: Data.self) else { throw Failure.unreadable }
        return try await Task.detached(priority: .userInitiated) {
            guard let picture = PhotoConversion.readable(data, type: type) else { throw Failure.unreadable }
            return try staging.stage(data: picture.data, name: "Photo.\(picture.fileExtension)", mimeType: picture.mimeType)
        }.value
    }
}

/// A video from Photos as a file: the system hands over a temporary copy, which is moved aside
/// before the system removes it, so the video is never read into memory.
struct PickedMovie: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ace-picked", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let target = folder.appendingPathComponent(UUID().uuidString).appendingPathExtension(received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: target)
            return PickedMovie(url: target)
        }
    }
}
