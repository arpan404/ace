import SwiftUI

/// The files on the next message, in one row above the words: a picture as a small thumbnail of
/// its staged bytes (tap to view it full screen), any other file, or one the bridge refused, as a
/// chip with its name and why. Upload progress and Remove show on both.
struct ComposerMediaStrip: View {
    let files: [AttachmentFile]
    /// Where the picked bytes were staged (`AttachMenu.staging`).
    var staging = AttachmentStaging()
    /// Space before the first file and after the last.
    var inset: CGFloat = AceTheme.Spacing.none
    let remove: (String) -> Void
    @State private var viewing: StagedMedia?
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: AceTheme.Spacing.xs) {
                ForEach(files) { file in
                    if file.kind == "image", file.state != "failed", let url = staging.file(file.id) {
                        ComposerMediaThumb(file: file, url: url) { viewing = StagedMedia(name: file.name, url: url) } remove: { remove(file.id) }
                    } else {
                        AttachmentChip(file: file) { remove(file.id) }
                    }
                }
            }
            .padding(.horizontal, inset)
        }
        .fullScreenCover(item: $viewing) { media in
            MediaViewer(title: media.name) { await MediaViewer.image(at: media.url) }
        }
    }
}

private struct StagedMedia: Identifiable {
    let name: String
    let url: URL
    var id: URL { url }
}

/// A staged picture, square and rounded, decoded off the main thread at the size it is drawn.
private struct ComposerMediaThumb: View {
    let file: AttachmentFile
    let url: URL
    let open: () -> Void
    let remove: () -> Void
    static let side: CGFloat = 56
    @Environment(\.displayScale) private var scale
    @State private var image: UIImage?
    var body: some View {
        Button(action: open) {
            ZStack(alignment: .bottom) {
                AceTheme.Colours.fill
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: Self.side, height: Self.side).clipped()
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
        .accessibilityLabel(file.state == "uploading" ? "\(file.name), uploading" : file.name)
        .accessibilityHint("Opens it full screen")
        .accessibilityAddTraits(.isImage)
        .accessibilityIdentifier("composer.media")
        .overlay(alignment: .topTrailing) {
            Button(action: remove) {
                AceIcon(.x, size: 10, weight: .bold, relativeTo: .caption2)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .frame(width: 18, height: 18)
                    .background(AceTheme.Colours.background.opacity(0.8), in: Circle())
                    .padding(AceTheme.Spacing.xxs)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(file.name)")
            .accessibilityIdentifier("composer.media.remove")
        }
        .task(id: url) {
            let pixels = Self.side * scale
            image = await Task.detached(priority: .userInitiated) { downsampledImage(at: url, pixels: pixels) }.value
        }
    }
}
