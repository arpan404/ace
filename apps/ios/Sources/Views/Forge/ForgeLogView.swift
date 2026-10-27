import SwiftUI

/// A check's log in monospace, read a page at a time as its lines come near the screen: the
/// bridge splits the log once, and the phone asks only for the lines it is about to draw. Each
/// line not yet read holds one line's height, so scrolling never jumps. Error lines take the
/// failed colour. `jump` scrolls to a line (a step's start, or the failure on opening). While
/// `live` (the check still runs) the tail is read again every couple of seconds, so new lines
/// arrive; another log (a new run) starts over. Which answers are taken is `ForgeLogPaging`'s.
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
    /// The check is still running: its log grows.
    var live = false
    @State private var paging: ForgeLogPaging
    @State private var failure: String?
    @State private var openedOnFocus = false

    init(client: ClientModel, name: String, request: [String: Any], total: Int?, focus: Int?,
         errors: Set<Int> = [], jump: Int? = nil, live: Bool = false) {
        self.client = client
        self.name = name
        self.request = request
        self.total = total
        self.focus = focus
        self.errors = errors
        self.jump = jump
        self.live = live
        _paging = State(initialValue: ForgeLogPaging(identity: Self.identity(of: request), total: total))
    }

    /// Which log a request names: its kind and run, never the page.
    static func identity(of request: [String: Any]) -> String {
        request.keys.sorted().filter { $0 != "from" && $0 != "count" }.map { "\($0)=\(request[$0] ?? "")" }.joined(separator: "&")
    }
    private var identity: String { Self.identity(of: request) }
    /// The page holding the failure has been read.
    private var focusLoaded: Bool { focus.map { paging.loaded($0) } ?? false }

    var body: some View {
        ScrollViewReader { proxy in
            LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                if let failure {
                    Text(failure).meta(AceTone.failed.text).padding(.vertical, AceTheme.Spacing.sm)
                } else if paging.count == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, AceTheme.Spacing.lg)
                }
                ForEach(0..<paging.lines, id: \.self) { index in
                    line(index).id(index).onAppear { read(paging.near(index)) }
                }
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("forge.log")
            .task(id: identity) {
                // Another log (a new run, another check) starts over at its failure or its top.
                if paging.identity != identity {
                    paging.show(identity, total: total)
                    openedOnFocus = false
                    failure = nil
                }
                read(paging.near(focus ?? 0))
            }
            .onChange(of: total) { _, total in paging.show(identity, total: total) }
            // A running check keeps writing: its tail is read again until it stops.
            .task(id: "\(identity)|\(live)") {
                guard live else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(2))
                    if Task.isCancelled { break }
                    read(paging.tail())
                }
            }
            .onChange(of: jump) { _, line in
                guard let line else { return }
                read(paging.near(line))
                withAnimation(AceMotion.smooth) { proxy.scrollTo(line, anchor: .top) }
            }
            // Opening on the failure: once the lines around it have arrived, and only once, so a
            // person already reading elsewhere is never pulled back.
            .onChange(of: focusLoaded, initial: true) { _, loaded in
                guard loaded, !openedOnFocus, let focus, focus > 0 else { return }
                openedOnFocus = true
                proxy.scrollTo(focus, anchor: .top)
                // Once more after the lines just read are laid out, which may move the target.
                Task { await Task.yield(); proxy.scrollTo(focus, anchor: .top) }
            }
        }
    }

    private func line(_ index: Int) -> some View {
        Text(verbatim: paging.line(index) ?? " ")
            .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(errors.contains(index) ? AceTone.failed.text : AceTheme.Colours.foreground)
            .frame(maxWidth: .infinity, minHeight: 16, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    /// Asks for each ticket's page; only the newest answer for this log is taken.
    private func read(_ tickets: [ForgeLogPaging.Ticket]) {
        for ticket in tickets {
            var payload = request
            payload["from"] = ticket.page * ForgeLogPaging.pageSize
            payload["count"] = ForgeLogPaging.pageSize
            Task {
                do {
                    let read = try await client.forgeLog(payload)
                    if paging.accept(ticket, lines: read.lines, total: read.total) { failure = nil }
                } catch {
                    paging.failed(ticket)
                    if ticket.identity == paging.identity { failure = "Couldn't read the log. \(error.localizedDescription)" }
                }
            }
        }
    }
}
