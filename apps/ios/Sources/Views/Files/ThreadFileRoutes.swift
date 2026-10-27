import QuickLook
import SwiftUI

/// Opens a local link from an agent's message (`url`, in the message `itemId`).
struct FileLinkOpener: Sendable {
    let open: @MainActor @Sendable (URL, String) -> Void
}
private struct FileLinksKey: EnvironmentKey {
    static let defaultValue: FileLinkOpener? = nil
}
extension EnvironmentValues {
    /// Set by a thread screen; an answer's local links open through it instead of on the phone.
    var fileLinks: FileLinkOpener? {
        get { self[FileLinksKey.self] }
        set { self[FileLinksKey.self] = newValue }
    }
}

/// Where a thread's files open: the ⋯ menu's Files screen, and an answer's links to files. A
/// link into the checkout opens its file at the line; a link to a file elsewhere on the computer
/// is fetched because that message links it, then shown in Quick Look (which can share it).
struct ThreadFileRoutes: ViewModifier {
    let model: ClientModel
    let threadId: String
    let subtitle: String
    @Binding var showFiles: Bool
    /// Puts `@path` into the composer; nil when this phone can't send.
    let mention: ((ComposerMention) -> Void)?
    @State private var linked: FileTarget?
    @State private var preview: URL?
    @State private var opening: String?
    @State private var problem: String?

    func body(content: Content) -> some View {
        content
            .environment(\.fileLinks, FileLinkOpener { url, itemId in open(url, itemId: itemId) })
            .navigationDestination(isPresented: $showFiles) {
                FilesScreen(model: model, scope: .thread(threadId), subtitle: subtitle, mention: mentionAndReturn)
            }
            .navigationDestination(item: $linked) { target in
                FileScreen(model: model, scope: .thread(threadId), target: target, mention: mentionAndReturn)
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
                    .accessibilityIdentifier("files.opening")
                }
            }
            .alert("Couldn't open the file", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK") { problem = nil }
            } message: { Text(problem ?? "") }
    }

    private var mentionAndReturn: ((ComposerMention) -> Void)? {
        guard let mention else { return nil }
        return { picked in
            showFiles = false
            linked = nil
            mention(picked)
        }
    }

    private func open(_ url: URL, itemId: String) {
        // The target as the message wrote it: the daemon checks it against the message's links.
        let reference = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        let scope = FilesScope.thread(threadId)
        Task {
            do {
                let link = try await model.files(scope, ["op": "link", "itemId": itemId, "reference": reference], as: FileLink.self)
                switch link.kind {
                case "checkout":
                    if let path = link.path { linked = FileTarget(path: path, line: link.line) }
                case "linked":
                    let name = link.name ?? "the file"
                    opening = name
                    defer { opening = nil }
                    do {
                        preview = try await model.fileCopy(scope, ["op": "linked", "itemId": itemId, "reference": reference])
                    } catch {
                        problem = "\(name) couldn't be read from the computer. Check that the file is still there, then try again."
                    }
                default:
                    break
                }
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

extension MarkdownView {
    /// An agent's local links open through the thread (`fileLinks`); web links open as usual.
    func fileLinks(_ opener: FileLinkOpener?, itemId: String) -> some View {
        environment(\.openURL, OpenURLAction { url in
            let scheme = url.scheme?.lowercased() ?? ""
            guard let opener, !["http", "https", "mailto", "tel", "sms"].contains(scheme) else { return .systemAction }
            opener.open(url, itemId)
            return .handled
        })
    }
}
