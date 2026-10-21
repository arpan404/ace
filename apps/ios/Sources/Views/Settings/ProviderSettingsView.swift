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
    var finished: Bool { ["succeeded", "failed", "cancelled"].contains(state) }
}
/// Settings › Providers: each coding-agent CLI on the machine with its status and usage, the same
/// rows as the machine's page, each opening its sign-in.
struct ProviderSettingsView: View {
    let model: ClientModel
    var body: some View {
        List {
            Section {
                if let info = model.providers {
                    ForEach(info.providers) { provider in
                        NavigationLink { ProviderSignInView(model: model, provider: provider.provider, name: provider.name) } label: {
                            ProviderRow(provider: provider)
                        }
                    }
                    if let problem = info.problem { ServiceProblem(message: problem) }
                } else if model.connection == "ready" {
                    HStack {
                        Capsule().fill(AceTheme.Colours.fill).frame(width: 120, height: 10)
                        Spacer(minLength: AceTheme.Spacing.sm)
                        Capsule().fill(AceTheme.Colours.fill).frame(width: 64, height: 10)
                    }
                    .accessibilityElement(children: .ignore).accessibilityLabel("Reading coding tools")
                } else {
                    Text("Shown once this phone reaches the computer.")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
            } header: { SettingsHeader("Coding tools", note: absentNote) }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Providers").navigationBarTitleDisplayMode(.inline)
        .task { model.refreshMachine() }.refreshable { model.refreshMachine() }
    }
    private var absentNote: String? {
        guard let absent = model.providers?.absent, !absent.isEmpty else { return nil }
        return "Not installed or disabled: \(absent.joined(separator: ", "))"
    }
}
/// One provider's sign-in on the paired machine: start it, then follow the CLI's steps (a link,
/// a code, a choice) until it finishes.
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
    var body: some View {
        List {
            Section {
                if instance == nil, ["claude", "codex", "opencode", "cursor", "pi"].contains(provider) {
                    NavigationLink { ProviderAccountsView(model: model, provider: provider, name: name) } label: { SettingsRow("Accounts") }
                }
                Button { request(["type": "provider.login.start", "provider": provider]) } label: { SettingsActionLabel(title: "Sign in") }
                    .buttonStyle(.plain)
                    .disabled(busy || progress.map { !$0.finished } == true || !model.canOperate)
            } header: { SettingsHeader("Sign-in", note: "Sign in to the coding agent installed on your paired machine.") }
            .settingsRow()
            if let progress {
                Section {
                    SettingsRow(title: progress.message ?? progress.prompt ?? progress.state.replacingOccurrences(of: "_", with: " ").capitalized,
                                description: progress.hint) { EmptyView() }
                    if let words = progress.userCode {
                        SettingsRow(title: "Code") {
                            Text(words).aceMonospace(SettingsStyle.value, relativeTo: .body)
                                .foregroundStyle(AceTheme.Colours.foreground).textSelection(.enabled)
                        }
                    }
                    if let raw = progress.url, let url = URL(string: raw), url.scheme == "https" {
                        Link(destination: url) {
                            SettingsRow(title: "Open provider sign-in") {
                                AceIcon(.arrowSquareOut, size: 16).foregroundStyle(AceTheme.Colours.subtleForeground)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(progress.choices ?? []) { choice in
                        Button { request(["type": "provider.login.input", "session": progress.session, "input": ["choice": choice.id]]) } label: {
                            SettingsActionLabel(title: choice.label)
                        }
                        .buttonStyle(.plain)
                    }
                    if progress.state == "awaiting_input", progress.codeEntry != true, (progress.choices ?? []).isEmpty {
                        Button { request(["type": "provider.login.input", "session": progress.session, "input": ["value": "enter"]]) } label: {
                            SettingsActionLabel(title: "Continue")
                        }
                        .buttonStyle(.plain)
                    }
                    if progress.codeEntry == true {
                        SecureField("Code from provider", text: $code).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .aceFont(SettingsStyle.label, relativeTo: .body)
                        Button {
                            let entry = code; code = ""
                            request(["type": "provider.login.input", "session": progress.session, "input": ["code": entry]])
                        } label: { SettingsActionLabel(title: "Continue") }
                        .buttonStyle(.plain)
                        .disabled(code.isEmpty)
                    }
                    if !progress.finished {
                        Button(role: .cancel) { request(["type": "provider.login.cancel", "session": progress.session]) } label: {
                            SettingsActionLabel(title: "Cancel sign-in")
                        }
                        .buttonStyle(.plain)
                    }
                } header: { SettingsHeader(progress.finished ? "Result" : "Continue sign-in") }
                .disabled(busy || !model.canOperate)
                .settingsRow()
            }
            if let problem {
                ServiceProblem(message: problem)
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: AceTheme.Spacing.sm, leading: SettingsStyle.margin,
                                              bottom: AceTheme.Spacing.sm, trailing: SettingsStyle.margin))
            }
        }
        .settingsList()
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

