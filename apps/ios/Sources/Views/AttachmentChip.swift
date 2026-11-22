import SwiftUI

/// A file on the next message: its name, then its upload's percent, its size, or why it can't
/// go. A thin line along its bottom edge shows the upload (`UploadLine`): blue while it goes, a
/// check and a full line a moment when it lands, red with Retry when it broke.
struct AttachmentChip: View {
    let file: AttachmentFile
    let remove: () -> Void
    /// Uploads a failed file again; nil, or a refusal a retry would meet again, offers nothing.
    var retry: (() -> Void)? = nil
    /// Puts a pasted file's words back in the message instead; nil where that can't happen.
    var asText: (() -> Void)? = nil
    /// Why a paste can't go back as text (it is too long); shown where Paste as Text would be.
    var staysAttached: String? = nil
    @State private var finishing = false
    private var failed: Bool { file.state == "failed" }
    private var retries: (() -> Void)? { failed && file.retry == true ? retry : nil }

    var body: some View {
        HStack(spacing: AceDesign.Space.tight) {
            AceIcon(icon, size: AceDesign.Size.glyphMeta, relativeTo: .footnote)
                .foregroundStyle(failed ? AceTheme.StatusText.failed : finishing ? AceTheme.StatusText.working : AceTheme.Colours.decoration)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(file.name).lineLimit(1).truncationMode(.middle).foregroundStyle(AceTheme.Colours.foreground)
                detail
            }
            if let retries {
                Button("Retry", action: retries)
                    .buttonStyle(.plain)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .frame(minHeight: AceDesign.Size.tap).contentShape(Rectangle())
                    .accessibilityIdentifier("composer.attachment.retry")
            }
            Button(action: remove) {
                AceIcon(.xCircle, size: AceDesign.Size.icon, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.decoration)
                    .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap).contentShape(Rectangle())
            }
                .buttonStyle(.plain).accessibilityLabel("Remove \(file.name)")
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .padding(.horizontal, AceDesign.Space.related).padding(.vertical, AceDesign.Space.tight)
        .background(AceTheme.Colours.fill)
        .overlay(alignment: .bottom) {
            UploadLine(state: file.state, progress: file.progress, finishing: finishing)
        }
        .clipShape(AceShape.capsule)
        .uploadFinishing(file.state, $finishing)
        .accessibilityElement(children: .combine)
        .accessibilityValue(file.state == "uploading" ? (file.progress > 0 ? "Uploading, \(percent)" : "Uploading") : "")
        .accessibilityIdentifier("composer.attachment")
        .contextMenu {
            if let asText {
                Button("Paste as Text", ace: .textAlignLeft, action: asText)
            } else if let staysAttached {
                Text(staysAttached)
            }
            if asText != nil || staysAttached != nil {
                Button("Remove", ace: .x, role: .destructive, action: remove)
            }
        }
        .accessibilityHint(staysAttached ?? "")
        .accessibilityActions {
            if let retries { Button("Retry", action: retries) }
            if let asText { Button("Paste as Text", action: asText) }
        }
    }

    private var icon: AceIcon.Name {
        if failed { return .warning }
        if finishing { return .check }
        return file.kind == "image" ? .image : file.kind == "video" ? .playCircle : .file
    }
    private var percent: String { "\(Int((file.progress * 100).rounded()))%" }
    @ViewBuilder private var detail: some View {
        if failed {
            Text(file.error).lineLimit(2).foregroundStyle(AceTheme.StatusText.failed)
        } else if file.state == "uploading" {
            Text(file.progress > 0 ? percent : "Uploading…")
                .monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
                .contentTransition(.numericText())
        } else {
            Text(ByteCountFormatter.string(fromByteCount: Int64(file.bytes), countStyle: .file)).monospacedDigit()
        }
    }
}
