import SwiftUI

/// A check's log in monospace, read a page at a time as its lines come near the screen: the
/// bridge splits the log once, and the phone asks only for the lines it is about to draw. Each
/// line not yet read holds one line's height, so scrolling never jumps. Error lines take the
/// failed colour. `jump` scrolls to a line (a step's start, or the failure on opening).
struct ForgeLogView: View {
    let client: ClientModel
    let name: String
    /// The log read without its page (`forge.pull.check.log` or `forge.local.log`).
    let request: [String: Any]
    /// The line count when the check page knows it; nil reads it with the first page.
    let total: Int?
    let focus: Int?
    var errors: Set<Int> = []
    var jump: Int?
    @State private var pages: [Int: [String]] = [:]
    @State private var count: Int?
    @State private var asked: Set<Int> = []
    @State private var failure: String?

    private static let pageSize = 200
    private var lines: Int { count ?? total ?? 0 }

    var body: some View {
        ScrollViewReader { proxy in
            LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                if let failure {
                    Text(failure).meta(AceTone.failed.text).padding(.vertical, AceTheme.Spacing.sm)
                } else if count == nil, total == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, AceTheme.Spacing.lg)
                }
                ForEach(0..<lines, id: \.self) { index in
                    line(index).id(index).onAppear { want(index) }
                }
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
            .accessibilityIdentifier("forge.log")
            .task { want(focus ?? 0) }
            .onChange(of: jump) { _, line in
                guard let line else { return }
                want(line)
                withAnimation(AceMotion.smooth) { proxy.scrollTo(line, anchor: .top) }
            }
            .task(id: focus) {
                // Opening on the failure: the lines around it are read first, then shown.
                guard let focus, focus > 0 else { return }
                try? await Task.sleep(for: .milliseconds(150))
                proxy.scrollTo(focus, anchor: .top)
            }
        }
    }

    private func line(_ index: Int) -> some View {
        let text = pages[index / Self.pageSize].flatMap { page in
            index % Self.pageSize < page.count ? page[index % Self.pageSize] : nil
        }
        return Text(verbatim: text ?? " ")
            .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(errors.contains(index) ? AceTone.failed.text : AceTheme.Colours.foreground)
            .frame(maxWidth: .infinity, minHeight: 16, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    /// Reads the page holding `index`, and the next one when the line is near its end.
    private func want(_ index: Int) {
        let page = index / Self.pageSize
        read(page)
        if index % Self.pageSize > Self.pageSize - 40 { read(page + 1) }
    }

    private func read(_ page: Int) {
        guard !asked.contains(page), count.map({ page * Self.pageSize < $0 }) ?? true else { return }
        asked.insert(page)
        var payload = request
        payload["from"] = page * Self.pageSize
        payload["count"] = Self.pageSize
        Task {
            do {
                let read = try await client.forgeLog(payload)
                pages[page] = read.lines
                if count != read.total { count = read.total }
                failure = nil
            } catch {
                asked.remove(page)
                failure = "Couldn't read the log. \(error.localizedDescription)"
            }
        }
    }
}
