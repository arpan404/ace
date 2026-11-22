import SwiftUI
import UniformTypeIdentifiers

/// How a message's images and files are read and opened. A thread screen or a Spade conversation
/// sets it (`MessageAttachmentRoutes`); without one the bubble still lays them out, unopened.
struct MessageAttachmentAccess {
    /// A preview already decoded this launch, for drawing on the first frame.
    let cached: @MainActor (_ itemId: String, _ ref: String) -> UIImage?
    /// The preview, at most `pixels` on its long side; nil when it can't be read.
    let thumbnail: @MainActor (_ itemId: String, _ ref: String, _ pixels: CGFloat) async -> UIImage?
    /// Opens `line`; for a picture, `pictures` are all the message's, swiped through from it.
    let open: @MainActor (_ itemId: String, _ line: AttachmentLine, _ pictures: [AttachmentLine]) -> Void
    /// The picture itself, from the message carrying it (or the thread's own list when nil).
    var original: @MainActor (_ itemId: String?, _ ref: String) async -> UIImage? = { _, _ in nil }
}

extension EnvironmentValues {
    @Entry var messageAttachments: MessageAttachmentAccess? = nil
}

/// A person's message's attachments, above its bubble and unframed, as the web draws them: the
/// images as one rounded group (one keeps its shape, more share a 2×2 grid whose last cell says
/// "+N"), then each file as a row with its name, size and type. A tile has its final size before
/// its bytes arrive, so the transcript never moves while previews load. `itemId` names the message
/// carrying them, as the source reads them.
struct MessageAttachments: View {
    let itemId: String
    let attachments: [AttachmentLine]
    let more: Int
    var body: some View {
        let images = attachments.filter(\.previewed)
        let files = attachments.filter { !$0.previewed }
        VStack(alignment: .trailing, spacing: AceDesign.Space.tight) {
            if !images.isEmpty { ImageGroup(itemId: itemId, images: images) }
            ForEach(Array(files.enumerated()), id: \.offset) { _, file in AttachmentFileLine(itemId: itemId, line: file) }
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
    let itemId: String
    let images: [AttachmentLine]
    private static let cell: CGFloat = 112
    private static let single: CGFloat = 240
    var body: some View {
        if images.count == 1, let image = images.first {
            AttachmentThumb(itemId: itemId, line: image, pictures: images, size: Self.fitted(image))
        } else {
            let shown = Array(images.prefix(4))
            let rest = images.count > 4 ? images.count - 3 : 0
            let columns = [GridItem(.fixed(Self.cell), spacing: AceDesign.Space.tight), GridItem(.fixed(Self.cell), spacing: AceDesign.Space.tight)]
            LazyVGrid(columns: columns, alignment: .trailing, spacing: AceDesign.Space.tight) {
                ForEach(Array(shown.enumerated()), id: \.offset) { index, image in
                    // "+N" opens the rest too: the viewer swipes through every picture from here.
                    AttachmentThumb(itemId: itemId, line: image, pictures: images, size: CGSize(width: Self.cell, height: Self.cell),
                                    more: index == 3 ? rest : 0)
                }
            }
            .frame(width: Self.cell * 2 + AceDesign.Space.tight)
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
    let itemId: String
    let line: AttachmentLine
    let pictures: [AttachmentLine]
    let size: CGSize
    var more = 0
    @Environment(\.messageAttachments) private var access
    @Environment(\.displayScale) private var scale
    @State private var loaded: UIImage?
    @State private var failed = false
    var body: some View {
        let ref = line.ref ?? ""
        let image = loaded ?? access?.cached(itemId, ref)
        Button { access?.open(itemId, line, pictures) } label: {
            ZStack {
                AceTheme.Colours.fill
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: size.width, height: size.height).clipped()
                } else if failed {
                    AceIcon(.image, size: AceDesign.Size.barIcon).foregroundStyle(AceTheme.Colours.subtleForeground)
                }
                if more > 0 {
                    AceDesign.Surface.veil
                    Text("+\(more)").aceFont(AceTheme.Typography.title, relativeTo: .title3).monospacedDigit()
                        .foregroundStyle(AceTheme.Colours.foreground)
                }
            }
            .frame(width: size.width, height: size.height)
            .clipShape(AceDesign.Shape.block)
            .contentShape(AceDesign.Shape.block)
        }
        .buttonStyle(.plain)
        .disabled(access == nil)
        .accessibilityLabel(more > 0 ? "\(more) more images" : line.name)
        .accessibilityAddTraits(.isImage)
        .accessibilityIdentifier("attachment.image.\(ref)")
        // Loads when the row is on screen; a cancelled load (scrolled away) starts again on return.
        // A read the host was too busy for (its previews' places full) is tried again a little
        // later, twice, while the tile stays on screen.
        .task(id: ref) {
            guard image == nil, let access, !ref.isEmpty else { return }
            for pause in [Duration.zero, .seconds(1), .seconds(3)] {
                if pause != .zero { try? await Task.sleep(for: pause) }
                if Task.isCancelled { return }
                if let read = await access.thumbnail(itemId, ref, max(size.width, size.height) * scale) {
                    if !Task.isCancelled { loaded = read }
                    return
                }
            }
            if !Task.isCancelled { failed = true }
        }
    }
}

private struct AttachmentFileLine: View {
    let itemId: String
    let line: AttachmentLine
    @Environment(\.messageAttachments) private var access
    var body: some View {
        let opens = line.opens == true && access != nil
        Button { access?.open(itemId, line, [line]) } label: {
            HStack(spacing: AceDesign.Space.related) {
                AceIcon(line.kind == "image" ? .image : line.kind == "pdf" || line.kind == "text" ? .fileText : .file,
                        size: AceDesign.Size.icon, relativeTo: .footnote)
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
            .frame(minHeight: AceDesign.Space.section + AceDesign.Space.related)
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
    static func key(_ scope: String, _ itemId: String, _ ref: String) -> NSString {
        "\(scope)|\(itemId)|\(ref)" as NSString
    }
}

/// Where a message's attachments are read from: a thread, because the message carries them, or
/// Spade's store by hash (`spade.image`, whose thumbnail is the daemon's 512-pixel preview, and
/// `spade.document` for a document). All answer in `AttachmentBytes`.
enum MessageAttachmentSource: Equatable, Sendable {
    case thread(String)
    case spade

    /// What the decoded previews are kept under, so two sources never share an entry.
    var scope: String {
        switch self {
        case let .thread(id): id
        case .spade: "spade"
        }
    }

    /// The request for one file: its `thumbnail` preview or the `original` itself. `name` is the
    /// file's, which a Spade document (ref `document:` and its hash) is read under.
    func request(_ itemId: String?, _ ref: String, variant: String, name: String? = nil) -> [String: Any] {
        switch self {
        case let .thread(threadId):
            var payload: [String: Any] = ["type": "native.attachment", "threadId": threadId, "ref": ref, "variant": variant]
            if let itemId { payload["itemId"] = itemId }
            return payload
        case .spade:
            if ref.hasPrefix(Self.spadeDocument) {
                let named = name.flatMap { $0.isEmpty ? nil : $0 } ?? "Document"
                return ["type": "spade.document", "sha256": String(ref.dropFirst(Self.spadeDocument.count)), "name": named]
            }
            return ["type": "spade.image", "sha256": ref, "variant": variant]
        }
    }
    private static let spadeDocument = "document:"
}

/// Where a message's attachments open: an image in the full-screen viewer, any other file
/// fetched because that message carries it and shown in Quick Look (which can share it).
struct MessageAttachmentRoutes: ViewModifier {
    let model: ClientModel
    let source: MessageAttachmentSource
    @State private var viewing: AttachmentTarget?
    @State private var preview: URL?
    @State private var opening: String?
    @State private var problem: String?

    func body(content: Content) -> some View {
        content
            .environment(\.messageAttachments, access)
            .fullScreenCover(item: $viewing) { target in
                MediaPager(pages: target.pictures.map { line in
                    MediaPager.Page(title: line.name.isEmpty ? "Image" : line.name) { await original(target.itemId, line) }
                }, start: target.start)
            }
            .quickLookPreview($preview)
            .overlay(alignment: .top) {
                if let opening {
                    HStack(spacing: AceDesign.Space.related) {
                        ProgressView().controlSize(.small)
                        Text("Opening \(opening)").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    }
                    .padding(.horizontal, AceDesign.Space.margin).frame(minHeight: AceDesign.Size.tap)
                    .floatingGlass()
                    .padding(.top, AceDesign.Space.related)
                    .accessibilityIdentifier("attachment.opening")
                }
            }
            .alert("Couldn't open the file", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK") { problem = nil }
            } message: { Text(problem ?? "") }
    }

    private var access: MessageAttachmentAccess {
        let model = model, source = source
        return MessageAttachmentAccess(
            cached: { itemId, ref in AttachmentThumbnails.cache.object(forKey: AttachmentThumbnails.key(source.scope, itemId, ref)) },
            thumbnail: { itemId, ref, pixels in
                let key = AttachmentThumbnails.key(source.scope, itemId, ref)
                if let hit = AttachmentThumbnails.cache.object(forKey: key) { return hit }
                let payload = source.request(itemId, ref, variant: "thumbnail")
                guard let reply = try? await model.service(payload, as: AttachmentBytes.self) else { return nil }
                let image = await Task.detached(priority: .userInitiated) {
                    Data(base64Encoded: reply.data).flatMap(ImageDecoding.source).flatMap { ImageDecoding.preview($0, pixels: pixels) }
                }.value
                if let image {
                    let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
                    AttachmentThumbnails.cache.setObject(image, forKey: key, cost: cost)
                }
                return image
            },
            open: { itemId, line, pictures in open(itemId, line, pictures) },
            original: { itemId, ref in
                let payload = source.request(itemId, ref, variant: "original")
                guard let reply = try? await model.service(payload, as: AttachmentBytes.self) else { return nil }
                return await MediaViewer.image(base64: reply.data)
            }
        )
    }

    /// The image itself, read because its message carries it, for the full-screen viewer.
    private func original(_ itemId: String, _ line: AttachmentLine) async -> UIImage? {
        guard let reply = try? await model.service(source.request(itemId, line.ref ?? "", variant: "original"), as: AttachmentBytes.self) else { return nil }
        return await MediaViewer.image(base64: reply.data)
    }

    private func open(_ itemId: String, _ line: AttachmentLine, _ pictures: [AttachmentLine]) {
        guard line.opens == true, let ref = line.ref, !ref.isEmpty else { return }
        if line.previewed {
            let shown = pictures.filter(\.previewed)
            viewing = AttachmentTarget(itemId: itemId, pictures: shown.isEmpty ? [line] : shown,
                                       start: shown.firstIndex(of: line) ?? 0)
            return
        }
        opening = line.name
        Task {
            defer { opening = nil }
            do {
                let reply = try await model.service(source.request(itemId, ref, variant: "original", name: line.name),
                                                    as: AttachmentBytes.self)
                guard let data = Data(base64Encoded: reply.data) else { throw ServiceFailure(message: "The file couldn't be decoded.") }
                preview = try Self.keep(data, named: reply.name)
            } catch {
                problem = "\(line.name) couldn't be read. Check the connection and try again."
            }
        }
    }

    /// A private copy for Quick Look, under the file's own name with any folders taken out.
    static func keep(_ data: Data, named name: String) throws -> URL {
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
    let itemId: String
    /// The message's pictures, swiped through from `start`.
    let pictures: [AttachmentLine]
    let start: Int
    var id: String { "\(itemId)|\(start)|\(pictures.first?.ref ?? "")" }
}
