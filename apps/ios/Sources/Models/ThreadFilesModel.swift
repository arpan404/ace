import Foundation
import Observation

/// One folder of a thread's checkout, within the bridge's row cap (`bridge/project-files.ts`).
struct FileListing: Codable, Sendable, Equatable {
    struct Row: Codable, Sendable, Identifiable, Equatable { let path: String; let name: String; let folder: Bool; var id: String { path } }
    let threadId: String?
    let folder: String
    let state: String
    let rows: [Row]
    /// Rows past the cap, counted but not sent.
    let hidden: Int
    /// The daemon listed only part of the checkout.
    let truncated: Bool
}
struct FileSearch: Codable, Sendable, Equatable { let threadId: String; let query: String; let state: String; let paths: [String] }
/// The start of one file, read-only and size-capped; `truncated` means the computer has the rest.
struct FilePreview: Codable, Sendable, Equatable {
    let threadId: String; let path: String; let state: String
    let text: String; let truncated: Bool; let binary: Bool
}

enum FilesPatch: Decodable, Sendable {
    case listing(FileListing)
    case search(FileSearch)
    case preview(FilePreview)
    private enum Keys: String, CodingKey { case type }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        switch try box.decode(String.self, forKey: .type) {
        case "files.listing": self = .listing(try FileListing(from: decoder))
        case "files.search": self = .search(try FileSearch(from: decoder))
        case "files.preview": self = .preview(try FilePreview(from: decoder))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: box, debugDescription: "Unknown files patch")
        }
    }
}

/// The Files sheet's reads for the open thread; folders are kept as visited so Back is instant.
@MainActor @Observable final class ThreadFilesModel {
    var listings: [String: FileListing] = [:]
    var search: FileSearch?
    var preview: FilePreview?
    func apply(_ patch: FilesPatch) {
        switch patch {
        case .listing(let listing): listings[listing.folder] = listing
        case .search(let result): search = result
        case .preview(let shown): preview = shown
        }
    }
    func reset() { listings = [:]; search = nil; preview = nil }
}
