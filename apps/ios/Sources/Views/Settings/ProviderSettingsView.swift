import SwiftUI

struct LoginReply: Decodable {
    struct Result: Decodable {
        let ok: Bool
        let error: String?
        let progress: LoginProgress?
    }
    let result: Result
}
struct LoginProgress: Decodable {
    struct Choice: Decodable, Identifiable {
        let id: String
        let label: String
        /// "sign_in_again": its earlier login didn't carry over to the CLI's current store.
        var note: String? = nil
    }
    let session: String
    let state: String
    let url: String?
    let userCode: String?
    let prompt: String?
    let message: String?
    let hint: String?
    let choices: [Choice]?
    let codeEntry: Bool?
    let returnUrlEntry: Bool?
    /// The CLI finishes this sign-in in its own terminal (`SignInTerminalRows`).
    var manual: LoginManual? = nil
    var finished: Bool { ["succeeded", "failed", "cancelled"].contains(state) }
}
struct ProviderSettingsView: View {
    let model: ClientModel
    @State private var others: OtherProvidersData?
    var body: some View {
        List {
            Section {
                ForEach(model.providers?.providers ?? []) { provider in
                    NavigationLink { ProviderPageView(model: model, provider: provider.provider, name: provider.name) } label: {
                        HStack(spacing: AceDesign.Space.row) {
                            ProviderMark(provider: provider.provider, size: AceDesign.Size.icon).frame(width: AceDesign.Size.icon + AceDesign.Space.related)
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                                Text(provider.name).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                                // The status word already says "Sign in needed"; the line adds only something new.
                                if provider.summary.caseInsensitiveCompare(provider.status.label) != .orderedSame {
                                    Text(provider.summary).font(AceDesign.Typeface.meta)
                                        .foregroundStyle(AceDesign.Ink.muted).lineLimit(2)
                                }
                            }
                            Spacer(minLength: AceDesign.Space.related)
                            StateLabel(status: provider.status)
                        }
                        .padding(.vertical, AceDesign.Space.tight)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .insetRowBackground()
            OtherProvidersSections(model: model, others: others)
            Section {
                NavigationLink { AcpRegistryView(model: model) } label: { InsetRow("Add agent", systemImage: "plus") }
            }
            .insetRowBackground()
            if let problem = model.providers?.problem { ServiceProblem(message: problem).listRowBackground(Color.clear) }
        }
        .insetGroupedList()
        .followOtherProviders(model, $others)
        .nativeTitle("Providers")
        .readWhenConnected(model) { model.refreshMachine() }.refreshable { model.refreshMachine() }
    }
}
struct ProviderSignInView: View {
    let model: ClientModel
    let provider: String
    let name: String
    var instance: String? = nil
    var initial: LoginProgress? = nil
    @State private var progress: LoginProgress?
    @State private var problem: String?
    @State private var pollProblem: String?
    @State private var busy = false
    @State private var code = ""
    @State private var returnAddress = ""
    @State private var query = ""
    @State private var lifetime = SignInLifetime()
    @State private var pollAttempt = 0
    @State private var failedRequest: [String: Any]?
    /// Past this many choices the list is searched by name (OpenCode offers about 240 services).
    private static let searchFrom = 12
    var body: some View {
        Form {
            Group {
                Section {
                    Text("Sign in to the coding agent installed on your paired machine.")
                    Button("Sign in") { request(["type": "provider.login.start", "provider": provider]) }
                        .disabled(busy || progress.map { !$0.finished } == true || !model.canOperate)
                }
                if let progress {
                    Section {
                        Text(progress.message ?? progress.prompt ?? progress.state.replacingOccurrences(of: "_", with: " ").capitalized)
                        if let hint = progress.hint { Text(hint) }
                        if let words = progress.userCode { Text(words).textSelection(.enabled).monospaced() }
                        if let manual = progress.manual { SignInTerminalRows(model: model, session: progress.session, manual: manual) }
                        if let raw = progress.url, let url = URL(string: raw), url.scheme == "https" {
                            Link("Open provider sign-in", destination: url)
                        }
                        ForEach(Self.matching(progress.choices ?? [], query)) { choice in
                            Button { request(["type": "provider.login.input", "session": progress.session, "input": ["choice": choice.id]]) } label: {
                                HStack {
                                    Text(choice.label)
                                    Spacer(minLength: AceDesign.Space.related)
                                    if choice.note == "sign_in_again" {
                                        Text("Sign in again").font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                                    }
                                }
                            }
                        }
                        if progress.state == "awaiting_input", progress.codeEntry != true, (progress.choices ?? []).isEmpty {
                            Button("Continue") { request(["type": "provider.login.input", "session": progress.session, "input": ["value": "enter"]]) }
                        }
                        if progress.codeEntry == true {
                            SecureField("Code from provider", text: $code).textInputAutocapitalization(.never).autocorrectionDisabled()
                            Button("Continue") {
                                let entry = code; code = ""
                                request(["type": "provider.login.input", "session": progress.session, "input": ["code": entry]])
                            }.disabled(code.isEmpty)
                        }
                        if progress.returnUrlEntry == true {
                            // The page after signing in points at the paired machine and can't load here.
                            SecureField("Address the page ended on", text: $returnAddress).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            Button("Continue") {
                                let entry = returnAddress.trimmingCharacters(in: .whitespacesAndNewlines); returnAddress = ""
                                request(["type": "provider.login.input", "session": progress.session, "input": ["returnUrl": entry]])
                            }.disabled(returnAddress.isEmpty)
                        }
                        if !progress.finished { Button("Cancel sign-in", role: .cancel) { request(["type": "provider.login.cancel", "session": progress.session]) } }
                    } header: { InsetHeader(progress.finished ? "Result" : "Continue sign-in") }.disabled(busy || !model.canOperate)
                }
                ServiceProblem(message: problem ?? pollProblem)
                if problem != nil || pollProblem != nil {
                    Button("Retry", action: retry).buttonStyle(.textAction()).disabled(busy)
                }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .modifier(ServiceSearch(enabled: (progress?.choices?.count ?? 0) > Self.searchFrom, query: $query))
        .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
        .onAppear {
            lifetime.cancel = { [weak model] session in
                guard let model else { return }
                Task { _ = try? await model.service(["type": "provider.login.cancel", "session": session], as: LoginReply.self) }
            }
            if progress == nil { progress = initial }
            lifetime.unfinishedSession = progress.flatMap { $0.finished ? nil : $0.session }
        }
        .onChange(of: progress?.state) { _, _ in
            lifetime.unfinishedSession = progress.flatMap { $0.finished ? nil : $0.session }
        }
        .task(id: "\(progress?.session ?? "")/\(pollAttempt)") {
            while let current = progress, !current.finished, !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(2))
                    let reply = try await model.service(["type": "provider.login.poll", "session": current.session], as: LoginReply.self)
                    guard reply.result.ok else { throw ServiceFailure(message: reply.result.error ?? "Sign-in unavailable") }
                    pollProblem = nil
                    progress = reply.result.progress
                    lifetime.unfinishedSession = progress.flatMap { $0.finished ? nil : $0.session }
                } catch { if !Task.isCancelled { pollProblem = error.localizedDescription }; return }
            }
            if progress?.state == "succeeded" { model.refreshMachine() }
        }
    }
    /// The choices whose name or id holds every typed word; "other" (any provider) always stays.
    static func matching(_ choices: [LoginProgress.Choice], _ query: String) -> [LoginProgress.Choice] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return choices }
        return choices.filter { choice in
            let text = "\(choice.label) \(choice.id)".lowercased()
            return choice.id == "other" || words.allSatisfy { text.contains($0) }
        }
    }
    private func retry() {
        if let payload = failedRequest { request(payload) }
        else { pollProblem = nil; pollAttempt += 1 }
    }
    /// A failed request worth sending again. An input carries the code or address the person typed,
    /// so it is never kept; Retry resumes the poll and they enter it again.
    static func repeatable(_ payload: [String: Any]) -> Bool {
        switch payload["type"] as? String {
        case "provider.login.start", "provider.login.cancel": true
        default: false
        }
    }
    private func request(_ payload: [String: Any]) {
        query = ""
        var payload = payload
        if payload["type"] as? String == "provider.login.start", let instance { payload["instance"] = instance }
        busy = true; problem = nil
        Task {
            defer { busy = false }
            do {
                let reply = try await model.service(payload, as: LoginReply.self)
                guard reply.result.ok else { throw ServiceFailure(message: reply.result.error ?? "Sign-in unavailable") }
                failedRequest = nil
                if pollProblem != nil { pollProblem = nil; pollAttempt += 1 }
                progress = reply.result.progress
                lifetime.unfinishedSession = progress.flatMap { $0.finished ? nil : $0.session }
            } catch {
                failedRequest = Self.repeatable(payload) ? payload : nil
                problem = error.localizedDescription
            }
        }
    }
}
/// The system search field, only while there is a long list of services to search.
private struct ServiceSearch: ViewModifier {
    let enabled: Bool
    @Binding var query: String
    func body(content: Content) -> some View {
        if enabled { content.searchable(text: $query, prompt: "Search services") } else { content }
    }
}
