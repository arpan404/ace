import SwiftUI

/// How a message's attachments are drawn: pictures as one group, videos as tiles that play, and
/// every other file as a row. Each group keeps the message's order.
struct AttachmentLayout: Equatable {
    let images: [AttachmentLine]
    let videos: [AttachmentLine]
    let files: [AttachmentLine]

    init(_ attachments: [AttachmentLine]) {
        images = attachments.filter(\.previewed)
        videos = attachments.filter { !$0.previewed && $0.plays }
        files = attachments.filter { !$0.previewed && !$0.plays }
    }
}

extension AttachmentLine {
    /// A video the machine can send: drawn as a tile and played in the app.
    var plays: Bool {
        opens == true && !(ref ?? "").isEmpty
            && (kind == "video" || (mimeType ?? "").hasPrefix("video/") || genericVideoType != nil)
    }

    /// The type a known video extension plays under when the file was sent as generic binary.
    var genericVideoType: String? {
        AttachmentVideoType.isGeneric(mimeType) ? AttachmentVideoType.fromExtension(name) : nil
    }
}

/// A video in a person's message: a 16:9 tile with a play button and its size. Its bytes are read
/// only when it's played, so a long thread never downloads the videos it scrolls past.
struct AttachmentVideoTile: View {
    let itemId: String
    let line: AttachmentLine
    @Environment(\.messageAttachments) private var access
    private static let width: CGFloat = 240
    var body: some View {
        Button { access?.open(itemId, line, [line]) } label: {
            ZStack {
                AceTheme.Colours.fill
                AceIcon(.playCircle, size: AceDesign.Size.videoPlay)
                    .foregroundStyle(AceTheme.Colours.foreground)
                if !line.detail.isEmpty {
                    Text(line.detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption2)
                        .lineLimit(1)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                        .padding(AceDesign.Space.related)
                }
            }
            .frame(width: Self.width, height: Self.width * 9 / 16)
            .clipShape(AceDesign.Shape.block)
            .contentShape(AceDesign.Shape.block)
        }
        .buttonStyle(.plain)
        .disabled(access == nil)
        .accessibilityLabel("Video, \(line.name.isEmpty ? "attachment" : line.name)")
        .accessibilityValue(line.detail)
        .accessibilityHint("Plays the video")
        .accessibilityIdentifier("attachment.video.\(line.ref ?? line.name)")
    }
}

/// A message's video, read and kept for the player.
struct MessageVideoTarget: Identifiable, Equatable {
    let name: String
    let url: URL
    let mimeType: String
    var id: URL { url }
}
