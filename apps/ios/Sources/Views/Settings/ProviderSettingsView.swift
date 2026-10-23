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
    struct Choice: Decodable, Identifiable { let id: String; let label: String }
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
    var finished: Bool { ["succeeded", "failed", "cancelled"].contains(state) }
}
struct ProviderSettingsView: View {
    let model: ClientModel
    var body: some View {
        List {
            ForEach(model.providers?.providers ?? []) { provider in
                NavigationLink { ProviderSignInView(model: model, provider: provider.provider, name: provider.name) } label: {
                    VStack(alignment: .leading) {
                        LabeledContent(provider.name, value: provider.status.label)
                        Text(provider.summary).foregroundStyle(AceTheme.Colours.mutedForeground)
                        ForEach(provider.usage, id: \.self) { usage in LabeledContent(usage.label, value: usage.left) }
                    }
                }
            }
            if let problem = model.providers?.problem { ServiceProblem(message: problem) }
            if let absent = model.providers?.absent, !absent.isEmpty { Text("Not installed or disabled: \(absent.joined(separator: ", "))") }
        }
        .navigationTitle("Providers").navigationBarTitleDisplayMode(.inline)
        .task { model.refreshMachine() }.refreshable { model.refreshMachine() }
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
    @State private var busy = false
    @State private var code = ""
    @State private var returnAddress = ""
    var body: some View {
        Form {
            Section {
                if instance == nil, ["claude", "codex", "opencode", "cursor", "pi"].contains(provider) {
                    NavigationLink("Accounts") { ProviderAccountsView(model: model, provider: provider, name: name) }
                }
                Text("Sign in to the coding agent installed on your paired machine.")
                Button("Sign in") { request(["type": "provider.login.start", "provider": provider]) }
                    .disabled(busy || progress.map { !$0.finished } == true || !model.canOperate)
            }
            if let progress {
                Section(progress.finished ? "Result" : "Continue sign-in") {
                    Text(progress.message ?? progress.prompt ?? progress.state.replacingOccurrences(of: "_", with: " ").capitalized)
                    if let hint = progress.hint { Text(hint) }
                    if let words = progress.userCode { Text(words).textSelection(.enabled).monospaced() }
                    if let raw = progress.url, let url = URL(string: raw), url.scheme == "https" {
                        Link("Open provider sign-in", destination: url)
                    }
                    ForEach(progress.choices ?? []) { choice in
                        Button(choice.label) { request(["type": "provider.login.input", "session": progress.session, "input": ["choice": choice.id]]) }
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
                }.disabled(busy || !model.canOperate)
            }
            ServiceProblem(message: problem)
        }
        .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
        .onAppear { if progress == nil { progress = initial } }
        .task(id: progress?.session) {
            while let current = progress, !current.finished, !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(2))
                    let reply = try await model.service(["type": "provider.login.poll", "session": current.session], as: LoginReply.self)
                    guard reply.result.ok else { throw ServiceFailure(message: reply.result.error ?? "Sign-in unavailable") }
                    progress = reply.result.progress
                } catch { if !Task.isCancelled { problem = error.localizedDescription }; return }
            }
            if progress?.state == "succeeded" { model.refreshMachine() }
        }
        .onDisappear {
            code = ""
            returnAddress = ""
            if let progress, !progress.finished { request(["type": "provider.login.cancel", "session": progress.session]) }
        }
    }
    private func request(_ payload: [String: Any]) {
        var payload = payload
        if payload["type"] as? String == "provider.login.start", let instance { payload["instance"] = instance }
        busy = true; problem = nil
        Task {
            defer { busy = false }
            do {
                let reply = try await model.service(payload, as: LoginReply.self)
                guard reply.result.ok else { throw ServiceFailure(message: reply.result.error ?? "Sign-in unavailable") }
                progress = reply.result.progress
            } catch { problem = error.localizedDescription }
        }
    }
}
