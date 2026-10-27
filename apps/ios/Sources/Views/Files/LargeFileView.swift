import SwiftUI

private struct FilePage: Decodable, Sendable {
    let text: String
    let offset: Int
    let nextOffset: Int
    let size: Int
    let version: String
    let done: Bool
}

/// A text file too large to show whole, read a page (about 256 KB) at a time with line numbers,
/// Show more at the foot, and Share that saves the whole file to the phone however big it is.
struct LargeFileView: View {
    let model: ClientModel
    let scope: FilesScope
    let path: String
    let size: Int?
    @AppStorage("files.wrap") private var wrap = false
    @State private var lines: [String] = []
    @State private var next = 0
    @State private var version: String?
    @State private var done = false
    @State private var loading = false
    @State private var failure: String?
    @State private var download: String?
    private var saved: FileDownload? { download.flatMap { model.files.downloads[$0] } }

    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
        header
        ScrollView(wrap ? .vertical : [.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                    HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.md) {
                        Text("\(index + 1)").foregroundStyle(AceTheme.Colours.decoration)
                            .frame(minWidth: 44, alignment: .trailing)
                        Text(line.isEmpty ? " " : line).foregroundStyle(AceTheme.Colours.foreground)
                            .lineLimit(wrap ? nil : 1).fixedSize(horizontal: !wrap, vertical: true)
                    }
                    .aceMonospace(FileDiffStyle.line, relativeTo: .caption)
                    .padding(.trailing, AceTheme.Spacing.lg)
                }
                footer
            }
            .textSelection(.enabled)
        }
        }
        .task(id: path) { if lines.isEmpty { await more() } }
        .onChange(of: saved?.phase) { _, phase in if phase == "saved" { UINotificationFeedbackGenerator().notificationOccurred(.success) } }
        .onDisappear { if let download { model.action(["type": "files.download.done", "id": download]) } }
    }

    private var header: some View {
        HStack {
            Text("\(ByteCountFormatter.string(fromByteCount: Int64(size ?? 0), countStyle: .file)) · read in pages")
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            Spacer()
            if let saved, saved.phase == "saved", let file = saved.filePath {
                ShareLink(item: URL(fileURLWithPath: file)) { Text("Share") }
            } else if let saved, saved.phase == "saving" {
                Text("Saving \(ByteCountFormatter.string(fromByteCount: Int64(saved.received), countStyle: .file))").monospacedDigit()
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            } else {
                Button("Save to phone") { save() }.accessibilityIdentifier("file.large.save")
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .padding(AceTheme.Spacing.lg)
    }

    @ViewBuilder private var footer: some View {
        if let failure {
            Text(failure).foregroundStyle(AceTheme.StatusText.failed).padding(AceTheme.Spacing.lg)
        } else if loading {
            ProgressView().frame(maxWidth: .infinity, minHeight: 44)
        } else if !done {
            Button {
                Task { await more() }
            } label: {
                Text("Show more · \(percent)% read").fontWeight(.medium).frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("file.large.more")
        }
    }
    private var percent: Int { size.map { $0 > 0 ? min(99, next * 100 / $0) : 0 } ?? 0 }

    private func more() async {
        guard !loading, !done else { return }
        loading = true; defer { loading = false }
        var operation: [String: Any] = ["op": "page", "path": path, "offset": next]
        if let version { operation["version"] = version }
        do {
            let page = try await model.files(scope, operation, as: FilePage.self)
            var text = page.text
            if text.hasSuffix("\n") { text.removeLast() }
            // A page ends after a line break, so the next one starts a fresh line.
            lines += text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            next = page.nextOffset
            version = page.version
            done = page.done
            failure = nil
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
    }
    private func save() {
        let id = "dl-\(UUID().uuidString.prefix(20))"
        download = id
        model.action(["type": "files.download", "id": id, "scope": scope.wire, "target": ["kind": "file", "path": path]])
    }
}
