import SwiftUI

/// Installing, updating or removing a provider's CLI on the computer: the plan (what runs,
/// where) first, then live progress with Cancel, then the result. The bridge owns the job
/// (`bridge/provider-install.ts`), so leaving the page and coming back shows the same one.
struct ProviderInstallSection: View {
    let model: ClientModel
    let provider: String
    @Binding var screen: InstallScreenData?
    @State private var problem: String?
    @State private var acting = false

    var body: some View {
        if let screen, !screen.idle {
            Section {
                if let status = screen.status {
                    HStack(spacing: AceTheme.Spacing.sm) {
                        StateLabel(status: status)
                        Spacer(minLength: AceTheme.Spacing.sm)
                        if screen.busy { ProgressView().controlSize(.small) }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("install.status")
                }
                ForEach(screen.facts) { fact in
                    LabeledContent(fact.term, value: fact.value).aceFont(InsetStyle.value, relativeTo: .body)
                }
                if !screen.lines.isEmpty {
                    ScrollView {
                        Text(screen.lines.joined(separator: "\n"))
                            .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 132)
                    .defaultScrollAnchor(.bottom)
                    .accessibilityLabel("Installer log")
                }
                if let message = screen.message {
                    Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                if let confirm = screen.confirm {
                    if confirm.destructive {
                        Button(confirm.label, role: .destructive) { act(["kind": "run"]) }
                            .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    } else {
                        Button(confirm.label) { act(["kind": "run"]) }
                            .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(AceTheme.Colours.foreground)
                            .frame(minHeight: AceTheme.Dimensions.touchTarget)
                            .accessibilityIdentifier("install.confirm")
                    }
                }
                if let retry = screen.retry {
                    Button("Retry") { act(["kind": "plan", "action": retry.action]) }
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                }
                if let link = screen.link, let url = URL(string: link.url), url.scheme == "https" {
                    Link(link.label, destination: url)
                }
                if screen.cancel {
                    Button("Cancel", role: .cancel) { act(["kind": "cancel"]) }
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                        .accessibilityIdentifier("install.cancel")
                } else if screen.finished {
                    Button("Done") { act(["kind": "dismiss"]) }
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                }
                ServiceProblem(message: problem)
            } header: { InsetHeader(screen.title) }
            .insetRowBackground()
            .disabled(acting || !model.canOperate)
            .transition(.opacity)
            .sensoryFeedback(.success, trigger: screen.status?.token == "done") { _, done in done }
            .sensoryFeedback(.error, trigger: screen.status?.token == "failed") { _, failed in failed }
        }
    }

    private func act(_ step: [String: Any]) {
        acting = true; problem = nil
        Task {
            defer { acting = false }
            do {
                let next = try await model.service(["type": "provider.install.act", "provider": provider, "step": step], as: InstallScreenData.self)
                withAnimation(.smooth) { screen = next }
            } catch { problem = error.localizedDescription }
        }
    }
}

extension ProviderInstallSection {
    /// Shows the plan for `action` ("install", "update", "uninstall") before anything runs.
    static func plan(_ model: ClientModel, provider: String, action: String) async throws -> InstallScreenData {
        try await model.service(["type": "provider.install.act", "provider": provider, "step": ["kind": "plan", "action": action]], as: InstallScreenData.self)
    }
    /// Follows the job while the page is open: each answer is the next change, or the same
    /// screen after a quiet wait. A finished job that changed the CLI reads the machine again.
    static func follow(_ model: ClientModel, provider: String, screen: Binding<InstallScreenData?>) async {
        var after = -1
        while !Task.isCancelled {
            do {
                let next = try await model.service(["type": "provider.install.watch", "provider": provider, "after": after], as: InstallScreenData.self, timeout: .seconds(40))
                if next != screen.wrappedValue {
                    let finishedNow = next.changed && screen.wrappedValue?.changed != true
                    withAnimation(.smooth) { screen.wrappedValue = next }
                    if finishedNow { model.refreshMachine() }
                }
                after = next.revision
            } catch {
                if Task.isCancelled { return }
                // Offline: wait for the connection rather than spin; the page reads again on reconnect.
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
}
