import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// How a message's images and files are read and opened. A thread screen sets it
/// (`MessageAttachmentRoutes`); without one the bubble still lays them out, unopened.
struct MessageAttachmentAccess {
    /// A preview already decoded this launch, for drawing on the first frame.
    let cached: @MainActor (_ itemId: String, _ ref: String) -> UIImage?
    /// The preview, at most `pixels` on its long side; nil when it can't be read.
    let thumbnail: @MainActor (_ itemId: String, _ ref: String, _ pixels: CGFloat) async -> UIImage?
    let open: @MainActor (_ row: TranscriptRow, _ line: AttachmentLine) -> Void
}

extension EnvironmentValues {
    @Entry var messageAttachments: MessageAttachmentAccess? = nil
}

/// A person's message's attachments, above its bubble and unframed, as the web draws them: the
/// images as one rounded group (one keeps its shape, more share a 2×2 grid whose last cell says
/// "+N"), then each file as a row with its name, size and type. A tile has its final size before
/// its bytes arrive, so the transcript never moves while previews load.
struct MessageAttachments: View {
    let row: TranscriptRow
    let attachments: [AttachmentLine]
    let more: Int
    var body: some View {
        let images = attachments.filter(\.previewed)
        let files = attachments.filter { !$0.previewed }
        VStack(alignment: .trailing, spacing: AceTheme.Spacing.xs) {
            if !images.isEmpty { ImageGroup(row: row, images: images) }
            ForEach(Array(files.enumerated()), id: \.offset) { _, file in AttachmentFileLine(row: row, line: file) }
            if more > 0 {
                Text("\(more) more").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
    }
}

extension AttachmentLine {
    /// Drawn as a picture: the phone can read a preview of it.
    var previewed: Bool { thumbnail == true && !(ref ?? "").isEmpty }
    /// "12 KB · PNG image": the size when known, and the type in the system's words.
    var detail: String {
        let size = (bytes ?? 0) > 0 ? ByteCountFormatter.string(fromByteCount: Int64(bytes ?? 0), countStyle: .file) : ""
        let type = mimeType.flatMap { UTType(mimeType: $0)?.localizedDescription }
            ?? (name as NSString).pathExtension.uppercased()
        let word = type.prefix(1).uppercased() + type.dropFirst()
        return [size, word].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

private struct ImageGroup: View {
    let row: TranscriptRow
    let images: [AttachmentLine]
    private static let cell: CGFloat = 112
    private static let single: CGFloat = 240
    var body: some View {
        if images.count == 1, let image = images.first {
            AttachmentThumb(row: row, line: image, size: Self.fitted(image))
        } else {
            let shown = Array(images.prefix(4))
            let rest = images.count > 4 ? images.count - 3 : 0
            let columns = [GridItem(.fixed(Self.cell), spacing: AceTheme.Spacing.xs), GridItem(.fixed(Self.cell), spacing: AceTheme.Spacing.xs)]
            LazyVGrid(columns: columns, alignment: .trailing, spacing: AceTheme.Spacing.xs) {
                ForEach(Array(shown.enumerated()), id: \.offset) { index, image in
                    AttachmentThumb(row: row, line: image, size: CGSize(width: Self.cell, height: Self.cell),
                                    more: index == 3 ? rest : 0)
                }
            }
            .frame(width: Self.cell * 2 + AceTheme.Spacing.xs)
        }
    }
    /// A lone image keeps its shape within 240×240 (4:3 when its shape isn't known).
    private static func fitted(_ image: AttachmentLine) -> CGSize {
        let width = image.width ?? 0, height = image.height ?? 0
        guard width > 0, height > 0 else { return CGSize(width: single, height: single * 3 / 4) }
        let scale = min(1, single / width, single / height)
        return CGSize(width: max(64, (width * scale).rounded()), height: max(64, (height * scale).rounded()))
    }
}

private struct AttachmentThumb: View {
    let row: TranscriptRow
    let line: AttachmentLine
    let size: CGSize
    var more = 0
    @Environment(\.messageAttachments) private var access
    @Environment(\.displayScale) private var scale
    @State private var loaded: UIImage?
    @State private var failed = false
    var body: some View {
        let ref = line.ref ?? ""
        let image = loaded ?? access?.cached(row.id, ref)
        Button { access?.open(row, line) } label: {
            ZStack {
                AceTheme.Colours.fill
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: size.width, height: size.height).clipped()
                } else if failed {
                    AceIcon(.image, size: 20).foregroundStyle(AceTheme.Colours.subtleForeground)
                }
                if more > 0 {
                    AceTheme.Colours.background.opacity(0.6)
                    Text("+\(more)").aceFont(AceTheme.Typography.title, relativeTo: .title3).monospacedDigit()
                        .foregroundStyle(AceTheme.Colours.foreground)
                }
            }
            .frame(width: size.width, height: size.height)
            .clipShape(AceShape.rounded(AceTheme.Radii.code))
            .contentShape(AceShape.rounded(AceTheme.Radii.code))
        }
        .buttonStyle(.plain)
        .disabled(access == nil)
        .accessibilityLabel(more > 0 ? "\(more) more images" : line.name)
        .accessibilityAddTraits(.isImage)
        .accessibilityIdentifier("attachment.image.\(ref)")
        // Loads when the row is on screen; a cancelled load (scrolled away) starts again on return.
        .task(id: ref) {
            guard image == nil, let access, !ref.isEmpty else { return }
            let read = await access.thumbnail(row.id, ref, max(size.width, size.height) * scale)
            if Task.isCancelled { return }
            if let read { loaded = read } else { failed = true }
        }
    }
}

private struct AttachmentFileLine: View {
    let row: TranscriptRow
    let line: AttachmentLine
    @Environment(\.messageAttachments) private var access
    var body: some View {
        let opens = line.opens == true && access != nil
        Button { access?.open(row, line) } label: {
            HStack(spacing: AceTheme.Spacing.sm) {
                AceIcon(line.kind == "image" ? .image : line.kind == "pdf" || line.kind == "text" ? .fileText : .file,
                        size: 16, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(line.name.isEmpty ? "Attachment" : line.name)
                        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        .lineLimit(1).truncationMode(.middle)
                        .foregroundStyle(AceTheme.Colours.foreground)
                    if !line.detail.isEmpty {
                        Text(line.detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .lineLimit(1)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
            }
            .frame(minHeight: AceTheme.Spacing.xxxl + AceTheme.Spacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!opens)
        .accessibilityElement(children: .combine)
        .accessibilityHint(opens ? "Opens the file" : "")
        .accessibilityIdentifier("attachment.file.\(line.ref ?? line.name)")
    }
}

/// The bytes of one attachment, as `native.attachment` answers.
struct AttachmentBytes: Decodable, Sendable {
    let kind: String
    let name: String
    let mimeType: String
    let data: String
}

/// Decoded previews, shared across a launch so a thumbnail scrolled away and back draws at once.
@MainActor enum AttachmentThumbnails {
    static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 48 * 1024 * 1024
        return cache
    }()
    static func key(_ threadId: String, _ itemId: String, _ ref: String) -> NSString {
        "\(threadId)|\(itemId)|\(ref)" as NSString
    }
}

/// `data` as an image no larger than `pixels` on its long side, decoded off the main thread's
/// budget: only the downsampled bitmap is ever held.
nonisolated func downsampledImage(_ data: Data, pixels: CGFloat) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    let options = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: max(1, pixels),
    ] as CFDictionary
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
    return UIImage(cgImage: image)
}

/// Where a thread's message attachments open: an image in the full-screen viewer, any other file
/// fetched because that message carries it and shown in Quick Look (which can share it).
struct MessageAttachmentRoutes: ViewModifier {
    let model: ClientModel
    let threadId: String
    @State private var viewing: AttachmentTarget?
    @State private var preview: URL?
    @State private var opening: String?
    @State private var problem: String?

    func body(content: Content) -> some View {
        content
            .environment(\.messageAttachments, access)
            .sheet(item: $viewing) { target in
                NavigationStack { NativeMediaView(model: model, threadId: threadId, item: target.row, attachment: target.line) }
                    .presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .quickLookPreview($preview)
            .overlay(alignment: .top) {
                if let opening {
                    HStack(spacing: AceTheme.Spacing.sm) {
                        ProgressView().controlSize(.small)
                        Text("Opening \(opening)").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    }
                    .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 36)
                    .floatingGlass()
                    .padding(.top, AceTheme.Spacing.sm)
                    .accessibilityIdentifier("attachment.opening")
                }
            }
            .alert("Couldn't open the file", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK") { problem = nil }
            } message: { Text(problem ?? "") }
    }

    private var access: MessageAttachmentAccess {
        let model = model, threadId = threadId
        return MessageAttachmentAccess(
            cached: { itemId, ref in AttachmentThumbnails.cache.object(forKey: AttachmentThumbnails.key(threadId, itemId, ref)) },
            thumbnail: { itemId, ref, pixels in
                let key = AttachmentThumbnails.key(threadId, itemId, ref)
                if let hit = AttachmentThumbnails.cache.object(forKey: key) { return hit }
                let payload: [String: Any] = ["type": "native.attachment", "threadId": threadId, "itemId": itemId, "ref": ref, "variant": "thumbnail"]
                guard let reply = try? await model.service(payload, as: AttachmentBytes.self) else { return nil }
                let image = await Task.detached(priority: .userInitiated) {
                    Data(base64Encoded: reply.data).flatMap { downsampledImage($0, pixels: pixels) }
                }.value
                if let image {
                    let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
                    AttachmentThumbnails.cache.setObject(image, forKey: key, cost: cost)
                }
                return image
            },
            open: { row, line in open(row, line) }
        )
    }

    private func open(_ row: TranscriptRow, _ line: AttachmentLine) {
        guard line.opens == true, let ref = line.ref, !ref.isEmpty else { return }
        if line.previewed {
            viewing = AttachmentTarget(row: row, line: line)
            return
        }
        opening = line.name
        Task {
            defer { opening = nil }
            do {
                let reply = try await model.service(["type": "native.attachment", "threadId": threadId, "itemId": row.id, "ref": ref, "variant": "original"], as: AttachmentBytes.self)
                guard let data = Data(base64Encoded: reply.data) else { throw ServiceFailure(message: "The file couldn't be decoded.") }
                preview = try Self.keep(data, named: reply.name)
            } catch {
                problem = "\(line.name) couldn't be read. Check the connection and try again."
            }
        }
    }

    /// A private copy for Quick Look, under the file's own name with any folders taken out.
    private static func keep(_ data: Data, named name: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ace-attachments", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safe = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespacesAndNewlines))
        let url = folder.appendingPathComponent(safe.isEmpty ? "file" : safe)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }
}

private struct AttachmentTarget: Identifiable {
    let row: TranscriptRow
    let line: AttachmentLine
    var id: String { "\(row.id)|\(line.ref ?? "")" }
}
