import SwiftUI

/// The first-run page as the bridge words it (`bridge/first-run.ts`).
struct FirstRunData: Decodable, Equatable {
    struct Row: Decodable, Equatable, Identifiable {
        let provider: String
        let name: String
        let status: StatusDisplay
        let detail: String?
        let ready: Bool
        /// "sign_in", "install", "update" or "open"; nil when there is nothing to do here.
        let step: String?
        let next: Bool
        var id: String { provider }
    }
    let offer: Bool
    let dismissed: Bool
    let ready: Int
    let installed: [Row]
    let missing: [Row]
    let progress: String
}

/// `setup.read` and `setup.dismiss`: the page, or why this computer won't list its agents.
struct FirstRunReply: Decodable {
    let ok: Bool
    let screen: FirstRunData?
    let message: String?
    func page() throws -> FirstRunData {
        guard ok, let screen else { throw ServiceFailure(message: message ?? "Couldn't read this computer's agents.") }
        return screen
    }
}

/// Where a row leads: the existing sign-in page, or the provider's page with its install or
/// update plan already open.
enum FirstRunRoute: Equatable {
    case signIn, page(start: String?)
    init(step: String?) {
        switch step {
        case "sign_in": self = .signIn
        case "install", "update": self = .page(start: step)
        default: self = .page(start: nil)
        }
    }
}

/// Connect your agents, as web's first-run setup: the agents on the computer, each ready or with
/// the one step that readies it. After pairing it opens only when nothing is ready and this phone
/// hasn't finished or skipped it; Settings › Providers › Set up agents opens it any time.
struct FirstRunView: View {
    let model: ClientModel
    /// Opened by pairing: it steps aside when the computer already has a ready agent.
    var afterPairing = false
    /// Leaves the page; opened from Settings it simply goes back.
    var done: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var page: FirstRunData?
    @State private var problem: String?
    @State private var leaving = false
    @State private var checking = false

    var body: some View {
        List {
            header
            if let page {
                Section {
                    LabeledContent("Ready", value: page.progress)
                        .accessibilityIdentifier("setup.progress")
                    Button(checking ? "Checking…" : "Check again") { Task { await checkAgain() } }
                        .disabled(checking || model.connection != "ready" || !model.canOperate)
                        .accessibilityIdentifier("setup.check")
                }
                .insetRowBackground()
                if !page.installed.isEmpty {
                    Section { ForEach(page.installed) { row($0) } } header: { InsetHeader("On this computer") }
                        .insetRowBackground()
                }
                if !page.missing.isEmpty {
                    Section { ForEach(page.missing) { row($0) } } header: {
                        InsetHeader(page.installed.isEmpty ? "Install an agent" : "More agents")
                    }
                    .insetRowBackground()
                }
            } else if problem == nil {
                Section { ForEach(0..<3, id: \.self) { _ in InsetRow("Loading", systemImage: nil) } }
                    .insetRowBackground()
                    .redacted(reason: .placeholder)
                    .accessibilityLabel("Checking this computer's agents")
            }
            if let problem {
                Section {
                    ServiceProblem(message: problem)
                    Button("Retry") { Task { await read() } }.buttonStyle(.textAction())
                }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .navigationTitle("Set up").navigationBarTitleDisplayMode(.inline)
        // Back from here would offer the pairing already made.
        .navigationBarBackButtonHidden(afterPairing)
        .toolbar {
            if (page?.ready ?? 0) > 0 {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { Task { await finish() } }.disabled(leaving)
                        .accessibilityIdentifier("setup.done")
                }
            } else {
                ToolbarItem(placement: afterPairing ? .cancellationAction : .primaryAction) {
                    Button("Skip for now") { Task { await finish() } }.disabled(leaving)
                        .accessibilityIdentifier("setup.skip")
                }
            }
        }
        // Coming back from a sign-in or an install reads again; so does a provider change pushed
        // while the page is open (`MachineProviders` follows them once asked).
        .onAppear { model.refreshMachine() }
        .readWhenConnected(model) { await read() }
        .onChange(of: model.providers) { _, _ in Task { await read() } }
    }

    private var header: some View {
        Section {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                AceIcon(.terminal, size: AceDesign.Size.emptyIcon, relativeTo: .title2)
                    .foregroundStyle(AceDesign.Ink.muted).accessibilityHidden(true)
                Text("Connect your agents").font(AceDesign.Typeface.title.weight(AceDesign.Typeface.strong))
                    .foregroundStyle(AceDesign.Ink.primary)
                Text("ace runs the coding agents already on your computer. Connect one to start your first thread.")
                    .font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.muted)
            }
            .accessibilityElement(children: .combine)
        }
        .listRowBackground(Color.clear)
    }

    @ViewBuilder private func row(_ row: FirstRunData.Row) -> some View {
        NavigationLink { destination(row) } label: {
            HStack(spacing: AceDesign.Space.row) {
                ProviderMark(provider: row.provider, size: AceDesign.Size.icon)
                    .frame(width: AceDesign.Size.icon + AceDesign.Space.related)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(row.name).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                    if row.next {
                        Text("Start here").font(AceDesign.Typeface.meta).foregroundStyle(AceTheme.StatusText.needsYou)
                    } else if let detail = row.detail {
                        Text(detail).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted).lineLimit(2)
                    }
                }
                Spacer(minLength: AceDesign.Space.related)
                StateLabel(status: row.status)
            }
            .padding(.vertical, AceDesign.Space.tight)
            .accessibilityElement(children: .combine)
        }
        .accessibilityIdentifier("setup.row.\(row.provider)")
    }

    @ViewBuilder private func destination(_ row: FirstRunData.Row) -> some View {
        switch FirstRunRoute(step: row.step) {
        case .signIn: ProviderSignInView(model: model, provider: row.provider, name: row.name)
        case .page(let start): ProviderPageView(model: model, provider: row.provider, name: row.name, start: start)
        }
    }

    private func read() async {
        do {
            let next = try await model.service(["type": "setup.read"], as: FirstRunReply.self).page()
            problem = nil
            // Pairing a computer that can already run a thread, or one this phone set up before.
            if afterPairing, page == nil, !next.offer { leave(); return }
            withAnimation { page = next }
        } catch {
            if !Task.isCancelled { problem = error.localizedDescription }
        }
    }

    /// Looks for installed CLIs and their sign-ins again, as Providers › Check again.
    private func checkAgain() async {
        struct Reply: Decodable { struct Result: Decodable { let ok: Bool }; let result: Result }
        checking = true
        defer { checking = false }
        _ = try? await model.service(["type": "providers.request", "operation": "refresh"], as: Reply.self)
        await read()
    }

    /// Done or Skip: the computer keeps it for this phone, so pairing again doesn't ask. A phone
    /// that may only read can't record it and simply leaves.
    private func finish() async {
        leaving = true
        defer { leaving = false }
        if model.canOperate {
            _ = try? await model.service(["type": "setup.dismiss", "dismissed": true], as: FirstRunReply.self)
        }
        leave()
    }
    private func leave() { if let done { done() } else { dismiss() } }
}
