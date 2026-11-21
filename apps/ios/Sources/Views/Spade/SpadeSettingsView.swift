import SwiftUI

/// Settings › Spade (web's Settings › Spade): General, Models and keys, Web search and Apps for
/// one machine's Spade, each its own page read afresh as it opens and again on a pull. It pushes
/// inside whichever stack shows it: Settings' own, or the sheet the Spade tab opens.
struct SpadeSettingsView: View {
    let client: ClientModel

    var body: some View {
        List {
            Section {
                ForEach(SpadeSettings.Page.allCases) { page in
                    NavigationLink { destination(page) } label: {
                        InsetRow(page.title, icon: page.icon)
                    }
                    .accessibilityIdentifier("spade.settings.\(page.rawValue)")
                }
            } footer: {
                if let line = client.spade.line, !line.ready { Text(line.sentence) }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .nativeTitle("Spade")
        .accessibilityIdentifier("spade.settings")
    }

    @ViewBuilder private func destination(_ page: SpadeSettings.Page) -> some View {
        switch page {
        case .general: SpadeGeneralPage(client: client)
        case .models: SpadeModelsPage(client: client)
        case .search: SpadeSearchPage(client: client)
        case .apps: SpadeAppsPage(client: client)
        }
    }
}

/// One of Settings › Spade's pages as it loads and changes: only the latest read shows, and a
/// change runs while the page's controls wait, landing as the page as it now is or as the reason
/// it was refused.
@MainActor @Observable final class SpadeSettingsLoad {
    let page: SpadeSettings.Page
    private(set) var reads = SpadeSettingsReads()
    /// A change is out: the page's controls wait for it.
    var busy: Bool { writing > 0 }
    private let read: @MainActor () async -> SpadeSettings.Answer
    /// Changes out or waiting their turn; each runs after the one before it.
    private var writing = 0
    private var tail: Task<Void, Never>?
    /// A read asked for while changes were out: it runs once they settle.
    private var readWanted = false

    init(page: SpadeSettings.Page, read: @escaping @MainActor () async -> SpadeSettings.Answer) {
        self.page = page
        self.read = read
    }
    convenience init(client: ClientModel, page: SpadeSettings.Page) {
        self.init(page: page) { await client.spadeSettingsRead(page) }
    }

    /// Reads the page. While a change is out the read waits for it, so it can never land older
    /// facts over what a change just confirmed.
    func load() async {
        guard writing == 0 else {
            readWanted = true
            return
        }
        let ticket = reads.begin()
        reads.land(await read(), ticket: ticket)
    }
    /// Make the change and let the page show what it came to.
    func change(_ write: @escaping @MainActor () async -> SpadeSettings.Answer) {
        Task { _ = await awaiting(write) }
    }
    /// The same, for a sheet that waits on the outcome itself. Changes run one at a time, in the
    /// order they were made.
    func awaiting(_ write: @escaping @MainActor () async -> SpadeSettings.Answer) async -> SpadeSettings.Answer {
        writing += 1
        let before = tail
        let turn = Task { @MainActor () -> SpadeSettings.Answer in
            await before?.value
            reads.clearRefusal()
            let ticket = reads.begin()
            let answer = await write()
            reads.changed(answer, ticket: ticket)
            return answer
        }
        tail = Task { _ = await turn.value }
        let answer = await turn.value
        writing -= 1
        if writing == 0, readWanted {
            readWanted = false
            await load()
        }
        return answer
    }
}

/// One of Settings › Spade's pages: read as it opens, on a pull and when Spade's state moves;
/// skeleton rows until the first read lands, the reason with Try again when it can't, and on a
/// page that needs Spade running, Spade's state while it isn't. A refused change says why at
/// the top. Sheets and dialogs go on the frame, which is the page's list.
struct SpadeSettingsPageFrame<Rows: View>: View {
    let client: ClientModel
    let load: SpadeSettingsLoad
    @ViewBuilder let rows: (SpadeSettings.Answer) -> Rows

    private var page: SpadeSettings.Page { load.page }

    var body: some View {
        List {
            if let notice = load.reads.notice {
                Section {
                    Text(notice)
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .accessibilityIdentifier("spade.settings.notice")
                }
                .insetRowBackground()
            }
            if let refusal = load.reads.refusal {
                Section {
                    Text(refusal)
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(AceTheme.StatusText.failed)
                        .accessibilityIdentifier("spade.settings.refusal")
                }
                .insetRowBackground()
            }
            if let answer = load.reads.answer {
                if page != .general, let line = answer.line, !line.ready {
                    notRunning(line)
                } else {
                    rows(answer)
                }
            } else if let problem = load.reads.problem {
                ProblemRow(problem, id: "spade.settings.problem") { Task { await load.load() } }
            } else {
                SkeletonRows(count: 3, label: page.title).listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
            }
        }
        .insetGroupedList()
        .refreshable { await load.load() }
        .nativeTitle(page.title)
        .task { await load.load() }
        .onChange(of: client.spade.line) { Task { await load.load() } }
        .accessibilityIdentifier("spade.settings.page.\(page.rawValue)")
    }

    /// Spade isn't running: its state, once, and where to turn it on.
    private func notRunning(_ line: SpadeModel.Line) -> some View {
        Section {
            Text(line.sentence)
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.muted)
                .accessibilityIdentifier("spade.settings.line")
        } footer: {
            if line.canTurnOn { Text("Turn it on in General.") }
        }
        .insetRowBackground()
    }
}

/// A row that says one thing about a setting: its title, a short line under it, and what it is
/// now, muted, on the right.
struct SpadeSettingRow: View {
    let title: String
    var line: String?
    var value: String?
    var body: some View {
        InsetRow(icon: nil, title: title, subtitle: line) { InsetValue(text: value) }
            .accessibilityElement(children: .combine)
    }
}
