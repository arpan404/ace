import UIKit
import UniformTypeIdentifiers

/// What another app shared: its words and links as one first message, and its images as JPEG or
/// PNG files. Anything that can't be read is left out, never fatal.
struct SharedItems: Sendable {
    var text = ""
    var images: [(data: Data, name: String, mimeType: String)] = []
    /// Shares hold at most this many images; the activation rule says the same.
    static let imageLimit = 4

    static func read(_ items: [NSExtensionItem]) async -> SharedItems {
        var words: [String] = []
        var links: [String] = []
        var images: [(data: Data, name: String, mimeType: String)] = []
        for item in items {
            if let title = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { words.append(title) }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier), images.count < imageLimit {
                    if let image = await image(provider, index: images.count + 1) { images.append(image) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let url = await link(provider), !url.isFileURL { links.append(url.absoluteString) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let text = await plainText(provider) { words.append(text) }
                }
            }
        }
        // A page shared from Safari brings its title as words; a link already in the words isn't repeated.
        let body = words.filter { !$0.isEmpty }.joined(separator: "\n\n")
        let extra = links.filter { !body.contains($0) }
        return SharedItems(text: ([body] + extra).filter { !$0.isEmpty }.joined(separator: "\n\n"), images: images)
    }

    private static func link(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { done in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in done.resume(returning: item as? URL) }
        }
    }
    private static func plainText(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { done in
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in done.resume(returning: item as? String) }
        }
    }
    /// PNG and JPEG go as they are; anything else (HEIC) as JPEG, which every agent reads.
    private static func image(_ provider: NSItemProvider, index: Int) async -> (data: Data, name: String, mimeType: String)? {
        let data: Data? = await withCheckedContinuation { done in
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in done.resume(returning: data) }
        }
        guard let data else { return nil }
        let type = provider.registeredTypeIdentifiers.compactMap(UTType.init).first { $0.conforms(to: .image) }
        if type?.conforms(to: .png) == true { return (data, "Image \(index).png", "image/png") }
        if type?.conforms(to: .jpeg) == true { return (data, "Image \(index).jpg", "image/jpeg") }
        guard let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.85) else { return nil }
        return (jpeg, "Image \(index).jpg", "image/jpeg")
    }
}
