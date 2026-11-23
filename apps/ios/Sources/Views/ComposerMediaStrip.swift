import SwiftUI

/// Files on the next message, with previews, upload progress and removal in one row.
struct ComposerMediaStrip: View {
    let files: [AttachmentFile]
    /// Where the picked bytes were staged (`AttachMenu.staging`).
    var staging = AttachmentStaging()
    /// Space from the composer's edge to the field's text.
    var inset: CGFloat = AceTheme.Spacing.none
    let remove: (String) -> Void
    /// Uploads a failed file again; nil offers no Retry.
    var retry: ((String) -> Void)? = nil
    /// Puts a pasted text file's words back in the message (`LargePaste`); nil offers nothing.
    var asText: ((String) -> Void)? = nil
    @State private var viewing: StagedMedia?
    @State private var carriedViewing: AttachmentFile?
    @Environment(\.messageAttachments) private var stored
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: AceDesign.Space.tight) {
                ForEach(files) { file in
                    if file.state == "failed" {
                        AttachmentChip(file: file, remove: { remove(file.id) }, retry: retry.map { retry in { retry(file.id) } },
                                       asText: restore(file), staysAttached: pasteLimit(file))
                    } else if let carried = file.carried, file.kind == "image", carried.thumbnail, stored != nil {
                        ComposerMediaTile(file: file, source: .carried(carried), open: { carriedViewing = file }, remove: { remove(file.id) })
                    } else if file.kind == "image" || file.kind == "video", let url = staging.file(file.id) {
                        ComposerMediaTile(file: file, source: .staged(url), open: { viewing = StagedMedia(file: file, url: url) }, remove: { remove(file.id) })
                    } else {
                        ComposerMediaTile(file: file, remove: { remove(file.id) }, asText: restore(file), staysAttached: pasteLimit(file))
                    }
                }
            }
            .padding(.leading, inset)
            .padding(.trailing, AceDesign.Space.margin)
        }
        .fixedSize(horizontal: false, vertical: true)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .fullScreenCover(item: $carriedViewing) { file in
            MediaViewer(title: file.name) {
                guard let carried = file.carried else { return nil }
                return await stored?.original(carried.itemId, carried.ref)
            }
        }
        .fullScreenCover(item: $viewing) { media in
            if let video = media.video {
                VideoViewer(title: media.name, url: media.url, mimeType: video)
            } else {
                MediaViewer(title: media.name) { await MediaViewer.image(at: media.url) }
            }
        }
    }

    private func restore(_ file: AttachmentFile) -> (() -> Void)? {
        guard let asText, ComposerIntake.restorable(file, in: staging) else { return nil }
        return { asText(file.id) }
    }

    private func pasteLimit(_ file: AttachmentFile) -> String? {
        asText == nil ? nil : ComposerIntake.staysAttached(file, in: staging)
    }
}

private struct StagedMedia: Identifiable {
    let name: String
    let url: URL
    /// The video's MIME type; nil for a picture.
    let video: String?
    var id: URL { url }
    init(file: AttachmentFile, url: URL) {
        name = file.name
        self.url = url
        video = file.kind == "video" ? (file.mimeType ?? "video/quicktime") : nil
    }
}

/// A fixed-size preview, with a file icon and name when no thumbnail is available.
private struct ComposerMediaTile: View {
    enum Source: Equatable { case staged(URL), carried(AttachmentFile.Carried) }
    let file: AttachmentFile
    var source: Source? = nil
    var open: (() -> Void)? = nil
    let remove: () -> Void
    var asText: (() -> Void)? = nil
    var staysAttached: String? = nil
    private let side = AceDesign.Size.attachmentTile
    private let reach = AceDesign.Space.related
    @Environment(\.displayScale) private var scale
    @Environment(\.messageAttachments) private var stored
    @State private var image: UIImage?
    @State private var length: String?
    @State private var unreadable = false
    @State private var finishing = false
    private var video: Bool { file.kind == "video" }
    var body: some View {
        Group {
            if let open, !unreadable {
                Button(action: open) { preview.contentShape(AceDesign.Shape.attachment) }
                    .buttonStyle(.plain)
                    .accessibilityHint(video ? "Plays it full screen" : "Opens it full screen")
                    .accessibilityIdentifier("composer.media")
            } else {
                preview
                    .accessibilityElement(children: .ignore)
                    .accessibilityIdentifier("composer.attachment")
                    .contextMenu {
                        if let asText { Button("Paste as Text", ace: .textAlignLeft, action: asText) }
                        if let staysAttached { Text(staysAttached) }
                        if asText != nil || staysAttached != nil {
                            Button("Remove", ace: .x, role: .destructive, action: remove)
                        }
                    }
                    .accessibilityHint(staysAttached ?? "")
                    .accessibilityActions {
                        if let asText { Button("Paste as Text", action: asText) }
                    }
            }
        }
        .accessibilityLabel([file.name, length].compactMap { $0 }.joined(separator: ", "))
        .accessibilityValue(file.state == "uploading" ? "Uploading" : "")
        .padding(.top, reach)
        .padding(.trailing, reach)
        .overlay(alignment: .topTrailing) {
            Button(action: remove) {
                AceIcon(.x, size: AceDesign.Size.glyphSmall, relativeTo: .caption2)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .frame(width: AceDesign.Size.badge, height: AceDesign.Size.badge)
                    .background(AceDesign.Surface.veil, in: Circle())
                    .padding(.top, reach + AceDesign.Space.tight)
                    .padding(.trailing, reach + AceDesign.Space.tight)
                    .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap, alignment: .topTrailing)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(file.name)")
            .accessibilityIdentifier("composer.media.remove")
        }
        .uploadFinishing(file.state, $finishing)
        .task(id: source) {
            switch source {
            case .carried(let carried):
                image = await stored?.thumbnail(carried.itemId, carried.ref, side * scale)
                unreadable = image == nil
            case .staged(let url):
                if video {
                    let frame = await VideoPreview.frame(url, mimeType: file.mimeType ?? "video/quicktime", pixels: side * scale)
                    image = frame.image
                    length = frame.seconds.map(VideoPreview.length)
                    unreadable = frame.image == nil && frame.seconds == nil
                } else {
                    image = await PreviewDecoder.shared.preview(at: url, pixels: side * scale)
                    unreadable = image == nil
                }
            case nil:
                break
            }
        }
    }

    private var preview: some View {
        ZStack {
            AceTheme.Colours.fill
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
                    .frame(width: side, height: side).clipped()
            } else {
                VStack(spacing: AceDesign.Space.tight) {
                    AceIcon(video ? .playCircle : file.kind == "image" ? .image : .file,
                            size: AceDesign.Size.glyphMeta, relativeTo: .caption2)
                    Text(file.name).lineLimit(1).truncationMode(.middle)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption2)
                }
                .foregroundStyle(AceTheme.Colours.foreground)
                .padding(.horizontal, AceDesign.Space.tight)
            }
            if let length {
                Text(length).aceFont(AceTheme.Typography.caption, relativeTo: .caption2).monospacedDigit()
                    .foregroundStyle(AceDesign.Ink.onMedia)
                    .shadow(color: AceDesign.Ink.onMediaShadow, radius: AceDesign.Ink.onMediaShadowRadius)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(AceDesign.Space.tight)
            }
        }
        .frame(width: side, height: side)
        .clipShape(AceDesign.Shape.attachment)
        .overlay(alignment: .bottom) {
            if file.state == "uploading" || finishing {
                UploadLine(state: file.state, progress: file.progress, finishing: finishing)
                    .background(AceDesign.Surface.veil)
                    .clipShape(AceDesign.Shape.control)
                    .padding(.horizontal, AceDesign.Space.related)
                    .padding(.bottom, AceDesign.Space.tight)
                    .allowsHitTesting(false)
            }
        }
    }
}
