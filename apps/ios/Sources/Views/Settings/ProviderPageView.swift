import SwiftUI

/// One provider's own page, as the web's provider page: its mark, version and update; its
/// status with the one action that fixes it; Accounts; sign-in routes; Behaviour (models);
/// Advanced (preferences, sign out, remove). Words come from the bridge
/// (`bridge/provider-page-view.ts`); this draws them. `extra` takes more sections (ACP
/// registry, MCP servers) between Behaviour and Advanced.
struct ProviderPageView<Extra: View>: View {
    let model: ClientModel
    let provider: String
    let name: String
    /// Opened from Not installed's Install: shows what installing runs at once.
    var start: String?
    @ViewBuilder var extra: (ProviderPageData) -> Extra
    @State private var page: ProviderPageData?
    @State private var problem: String?
    @State private var install: InstallScreenData?
    @State private var busy = false
    @State private var saved = 0
    @State private var editProblem: String?
    @State private var started = false

    init(model: ClientModel, provider: String, name: String, start: String? = nil, @ViewBuilder extra: @escaping (ProviderPageData) -> Extra) {
        self.model = model
        self.provider = provider
        self.name = name
        self.start = start
        self.extra = extra
        _page = State(initialValue: model.kept(ProviderPageData.read(provider, admin: model.canAdmin == true), as: ProviderPageData.self))
    }

    var body: some View {
        ScrollViewReader { proxy in
        List {
            if let page {
                header(page)
                status(page)
                ProviderInstallSection(model: model, provider: provider, screen: $install).id("install")
                if !page.missing { access(page) }
                if let models = page.models, !page.off { ProviderBehaviourSection(model: model, provider: provider, models: models) }
                extra(page)
                if page.mcp {
                    Section {
                        NavigationLink { ProviderMcpView(model: model, provider: provider, name: page.name) } label: {
                            InsetRow("MCP servers", systemImage: nil)
                        }
                        .accessibilityIdentifier("provider.mcp")
                    }
                    .insetRowBackground()
                }
                ProviderAdvancedSection(model: model, page: page, removeCLI: { plan("uninstall") }) { saved += 1 }
                if !page.about.isEmpty { about(page) }
            } else if let problem {
                Section {
                    ServiceProblem(message: problem)
                    Button("Retry") { Task { await read() } }.frame(minHeight: AceDesign.Size.tap)
                }.insetRowBackground()
            } else {
                placeholder
            }
        }
        .insetGroupedList()
        .onChange(of: install?.title) { if install?.idle == false { withAnimation { proxy.scrollTo("install", anchor: .top) } } }
        }
        .smoothChange(page)
        .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: saved)
        .task(id: [model.connection == "ready" ? 1 : 0, model.readGeneration(ProviderPageData.read(provider, admin: model.canAdmin == true))]) {
            if model.connection == "ready" { await read() }
        }
        .task(id: provider) { await ProviderInstallSection.follow(model, provider: provider, screen: $install) }
        .task {
            guard let start, !started else { return }
            started = true
            plan(start)
        }
        .refreshable { await read() }
    }

    private func read() async {
        do {
            let next = try await model.read(ProviderPageData.read(provider, admin: model.canAdmin == true), as: ProviderPageData.self)
            withAnimation { page = next; problem = nil }
        } catch {
            // The last page this phone saw stays; the problem shows only when there is none.
            if page == nil { problem = "Couldn't read \(name) on this computer. Check the connection and retry." }
        }
    }

    private func plan(_ action: String) {
        busy = true; editProblem = nil
        Task {
            defer { busy = false }
            do {
                let next = try await ProviderInstallSection.plan(model, provider: provider, action: action)
                withAnimation { install = next }
            } catch { editProblem = error.localizedDescription }
        }
    }

    @ViewBuilder private func header(_ page: ProviderPageData) -> some View {
        Section {
            HStack(spacing: AceDesign.Space.row) {
                ProviderMark(provider: provider, size: AceDesign.Size.headerMark).opacity(page.missing ? AceDesign.Ink.recede : 1).grayscale(page.missing ? 1 : 0)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(page.name).font(AceDesign.Typeface.title.weight(AceDesign.Typeface.strong)).foregroundStyle(AceDesign.Ink.primary)
                    if page.version != nil || page.update != nil {
                        HStack(spacing: AceDesign.Space.tight) {
                            if let version = page.version { Text(version).monospacedDigit().foregroundStyle(AceDesign.Ink.muted) }
                            if page.version != nil, page.update != nil { Text("·").foregroundStyle(AceDesign.Ink.muted) }
                            if let update = page.update { Text(update).foregroundStyle(AceTheme.StatusText.needsYou) }
                        }
                        .font(AceDesign.Typeface.meta)
                    }
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        }
        .listRowBackground(Color.clear)
    }

    @ViewBuilder private func status(_ page: ProviderPageData) -> some View {
        Section {
            HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                StateLabel(status: page.status)
                Spacer(minLength: AceDesign.Space.related)
            }
            .accessibilityIdentifier("provider.status")
            if let detail = page.detail {
                Text(detail).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
            }
            if let fix = page.fix, install?.idle ?? true { fixButton(fix, page) }
            if page.updateToo, install?.idle ?? true {
                Button("Update") { plan("update") }.frame(minHeight: AceDesign.Size.tap)
                    .accessibilityIdentifier("provider.update")
            }
            ServiceProblem(message: editProblem)
        }
        .insetRowBackground()
        .disabled(busy || !model.canOperate)
    }

    @ViewBuilder private func fixButton(_ fix: ProviderPageData.Fix, _ page: ProviderPageData) -> some View {
        switch fix.action {
        case "sign_in":
            NavigationLink { ProviderSignInView(model: model, provider: provider, name: page.name) } label: {
                Text(fix.label).foregroundStyle(AceDesign.Ink.accent)
            }
            .accessibilityIdentifier("provider.fix")
        case "turn_on":
            Button(fix.label) { edit(["kind": "enabled", "on": true]) }
                .buttonStyle(.textAction(.prominent))
                .frame(minHeight: AceDesign.Size.tap).accessibilityIdentifier("provider.fix")
        default:
            Button(fix.label) { plan(fix.action) }
                .buttonStyle(.textAction(.prominent))
                .frame(minHeight: AceDesign.Size.tap).accessibilityIdentifier("provider.fix")
        }
    }

    @ViewBuilder private func access(_ page: ProviderPageData) -> some View {
        Section {
            if page.accounts {
                NavigationLink { ProviderAccountsView(model: model, provider: provider, name: page.name) } label: {
                    InsetRow("Accounts", systemImage: nil)
                }
            }
            if page.fix?.action != "sign_in", !page.off {
                NavigationLink { ProviderSignInView(model: model, provider: provider, name: page.name) } label: {
                    InsetRow("Sign in", systemImage: nil)
                }
            }
            if let terminal = page.terminal {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text("In a terminal on the computer").font(AceDesign.Typeface.body)
                    (Text("Run ") + Text(terminal.run).monospaced() + Text(terminal.prompt.map { ", then type \($0)" } ?? ""))
                        .font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted).textSelection(.enabled)
                }
                .padding(.vertical, AceDesign.Space.tight)
            }
        } header: { InsetHeader("Sign-in") } footer: {
            if let apiKey = page.apiKey { Text(apiKey) }
        }
        .insetRowBackground()
    }

    @ViewBuilder private func about(_ page: ProviderPageData) -> some View {
        Section {
            ForEach(page.about) { fact in
                LabeledContent(fact.term) {
                    if fact.code { Text(fact.value).monospaced().textSelection(.enabled).multilineTextAlignment(.trailing) }
                    else { Text(fact.value).multilineTextAlignment(.trailing) }
                }
                .font(AceDesign.Typeface.body)
            }
        } header: { InsetHeader("About") }
        .insetRowBackground()
    }

    /// Rows held in place while the first read arrives, so nothing jumps when it lands.
    private var placeholder: some View {
        Group {
            Section { InsetRow(name, systemImage: nil, value: "Checking…") }
            Section { ForEach(0..<3, id: \.self) { _ in InsetRow("Loading", systemImage: nil) } }
        }
        .insetRowBackground()
        .redacted(reason: .placeholder)
        .accessibilityLabel("Loading \(name)")
    }

    private func edit(_ change: [String: Any]) {
        busy = true
        Task {
            defer { busy = false }
            do { try await model.editProvider(provider, change); editProblem = nil; saved += 1; model.refreshMachine() }
            catch { editProblem = error.localizedDescription }
        }
    }
}

extension ProviderPageView where Extra == EmptyView {
    init(model: ClientModel, provider: String, name: String, start: String? = nil) {
        self.init(model: model, provider: provider, name: name, start: start) { _ in EmptyView() }
    }
}
