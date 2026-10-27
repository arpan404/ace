import SwiftUI

/// The files on the next message, in one row above the words: a picture or video as a small
/// thumbnail of its staged bytes (a video with its length; tap to view or play it full screen),
/// any other file, or one the bridge refused, as a chip with its name and why. Upload progress
/// and Remove show on both.
struct ComposerMediaStrip: View {
    let files: [AttachmentFile]
    /// Where the picked bytes were staged (`AttachMenu.staging`).
    var staging = AttachmentStaging()
    /// Space before the first file and after the last.
    var inset: CGFloat = AceTheme.Spacing.none
    let remove: (String) -> Void
    @State private var viewing: StagedMedia?
    @State private var carriedViewing: AttachmentFile?
    @Environment(\.messageAttachments) private var stored
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            // Spaced and padded so each thumbnail's Remove target, which reaches past its corner,
            // stays inside the row and clear of the next file.
            HStack(spacing: ComposerMediaThumb.reach + AceTheme.Spacing.xxs) {
                ForEach(files) { file in
                    if let carried = file.carried, file.kind == "image", carried.thumbnail, stored != nil {
                        ComposerMediaThumb(file: file, source: .carried(carried)) { carriedViewing = file } remove: { remove(file.id) }
                            .transition(.opacity)
                    } else if file.kind == "image" || file.kind == "video", file.state != "failed", let url = staging.file(file.id) {
                        ComposerMediaThumb(file: file, source: .staged(url)) { viewing = StagedMedia(file: file, url: url) } remove: { remove(file.id) }
                    } else {
                        AttachmentChip(file: file) { remove(file.id) }
                    }
                }
            }
            .padding(.horizontal, inset)
            .padding(.top, ComposerMediaThumb.reach).padding(.trailing, ComposerMediaThumb.reach)
        }
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

/// A staged picture or video, square and rounded, decoded off the main thread at the size it is
/// drawn (a picture one at a time, a video's first frame with its length). One the phone can't
/// decode (SVG, PSD, a broken file) shows as a chip.
private struct ComposerMediaThumb: View {
    /// Where the picture comes from: a file staged on the phone, or one the thread already stores.
    enum Source: Equatable { case staged(URL), carried(AttachmentFile.Carried) }
    let file: AttachmentFile
    let source: Source
    let open: () -> Void
    let remove: () -> Void
    static let side: CGFloat = 56
    /// Remove answers a 44pt square over the thumbnail's top-right corner that reaches `reach`
    /// past it, so it never covers the middle, where a tap opens the picture.
    static let target: CGFloat = 44
    static let reach: CGFloat = 20
    @Environment(\.displayScale) private var scale
    @Environment(\.messageAttachments) private var stored
    @State private var image: UIImage?
    @State private var length: String?
    @State private var unreadable = false
    private var video: Bool { file.kind == "video" }
    var body: some View {
        if unreadable { AttachmentChip(file: file, remove: remove) } else { thumb }
    }
    private var thumb: some View {
        Button(action: open) {
            ZStack(alignment: .bottom) {
                AceTheme.Colours.fill
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: Self.side, height: Self.side).clipped()
                }
                if let length {
                    Text(length).aceFont(AceTheme.Typography.caption, relativeTo: .caption2).monospacedDigit()
                        .foregroundStyle(Color.white)
                        .shadow(color: .black.opacity(0.6), radius: 2)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .padding(AceTheme.Spacing.xs)
                }
                if file.state == "uploading" {
                    ProgressView(value: file.progress).progressViewStyle(.linear)
                        .tint(AceTheme.Colours.foreground)
                        .padding(.horizontal, AceTheme.Spacing.xs).padding(.bottom, AceTheme.Spacing.xs)
                        .accessibilityHidden(true)
                }
            }
            .frame(width: Self.side, height: Self.side)
            .clipShape(AceShape.rounded(AceTheme.Radii.code))
            .contentShape(AceShape.rounded(AceTheme.Radii.code))
        }
        .buttonStyle(.plain)
        .accessibilityLabel([file.name, length.map { "video, \($0)" }, file.state == "uploading" ? "uploading" : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint(video ? "Plays it full screen" : "Opens it full screen")
        .accessibilityAddTraits(.isImage)
        .accessibilityIdentifier("composer.media")
        .overlay(alignment: .topTrailing) {
            Button(action: remove) {
                AceIcon(.x, size: 10, weight: .bold, relativeTo: .caption2)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .frame(width: 18, height: 18)
                    .background(AceTheme.Colours.background.opacity(0.8), in: Circle())
                    // The X sits inside the thumbnail's corner, at the target's lower left.
                    .padding(.leading, 5).padding(.bottom, 5)
                    .frame(width: Self.target, height: Self.target, alignment: .bottomLeading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .offset(x: Self.reach, y: -Self.reach)
            .accessibilityLabel("Remove \(file.name)")
            .accessibilityIdentifier("composer.media.remove")
        }
        .task(id: source) {
            guard case .staged(let url) = source else {
                if case .carried(let carried) = source {
                    image = await stored?.thumbnail(carried.itemId, carried.ref, Self.side * scale)
                    unreadable = image == nil
                }
                return
            }
            if video {
                let frame = await VideoPreview.frame(url, mimeType: file.mimeType ?? "video/quicktime", pixels: Self.side * scale)
                image = frame.image
                length = frame.seconds.map(VideoPreview.length)
                unreadable = frame.image == nil && frame.seconds == nil
            } else {
                image = await PreviewDecoder.shared.preview(at: url, pixels: Self.side * scale)
                unreadable = image == nil
            }
        }
    }
}
