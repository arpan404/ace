import SwiftUI

/// A provider's Advanced settings: on or off, its CLI path (empty finds it automatically),
/// Cursor's checkpoint budget, a native mode, and the red actions: sign out and remove the CLI.
/// Typed values are checked by the bridge (`@ace/ui-core` provider preferences), which says why
/// one can't be saved.
struct ProviderAdvancedSection: View {
    let model: ClientModel
    let page: ProviderPageData
    let removeCLI: () -> Void
    let saved: () -> Void
    @State private var path = ""
    @State private var checkpoint = ""
    @State private var pathProblem: String?
    @State private var checkpointProblem: String?
    @State private var problem: String?
    @State private var saving = false
    @State private var confirmSignOut = false
    @State private var signingOut = false
    @State private var signOutResult: String?
    @FocusState private var focus: Field?
    private enum Field { case path, checkpoint }

    var body: some View {
        Section {
            Toggle("Use \(page.name)", isOn: Binding(get: { page.settings.enabled }, set: { on in save(["kind": "enabled", "on": on]) }))
                .disabled(page.missing)
                .accessibilityIdentifier("provider.enabled")
            if let saved = page.settings.path {
                LabeledContent("CLI path") {
                    TextField("Automatic", text: $path)
                        .multilineTextAlignment(.trailing).monospaced()
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .focused($focus, equals: .path).submitLabel(.done)
                        .onSubmit { commitPath(saved) }
                        .accessibilityIdentifier("provider.path")
                }
                if let pathProblem { problemLine(pathProblem) }
            }
            if let command = page.settings.approvedCommand {
                LabeledContent("CLI path") { Text(command).foregroundStyle(AceTheme.Colours.mutedForeground).multilineTextAlignment(.trailing) }
            }
            if let saved = page.settings.checkpoint {
                LabeledContent("Checkpoint budget per thread") {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        TextField("32", text: $checkpoint).multilineTextAlignment(.trailing).keyboardType(.numberPad)
                            .focused($focus, equals: .checkpoint).frame(maxWidth: 64)
                            .accessibilityIdentifier("provider.checkpoint")
                        Text("MB").foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
                if let checkpointProblem { problemLine(checkpointProblem) }
                if focus == .checkpoint { Button("Save budget") { commitCheckpoint(saved) }.frame(minHeight: AceTheme.Dimensions.touchTarget) }
            }
            if let native = page.settings.nativeMode {
                Picker("Native mode", selection: Binding(get: { native.value }, set: { mode in save(["kind": "nativeMode", "mode": mode]) })) {
                    ForEach(native.options) { Text($0.label).tag($0.id) }
                    if !native.options.contains(where: { $0.id == native.value }) { Text(native.label).tag(native.value) }
                }
                .pickerStyle(.menu)
            }
            if page.signOut {
                Button(signingOut ? "Signing out…" : "Sign out", role: .destructive) { confirmSignOut = true }
                    .disabled(signingOut).frame(minHeight: AceTheme.Dimensions.touchTarget)
                if let signOutResult { Text(signOutResult).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground) }
            }
            if page.settings.removable {
                // Shows the removal plan; its red Remove CLI is the confirmation.
                Button("Remove provider…", role: .destructive, action: removeCLI)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .accessibilityIdentifier("provider.remove")
            }
            ServiceProblem(message: problem)
        } header: { InsetHeader("Advanced") }
        .insetRowBackground()
        .toggleStyle(.systemSwitch)
        .disabled(saving || !model.canOperate)
        .onAppear(perform: syncFields)
        .onChange(of: page.settings) { if focus == nil { syncFields() } }
        .onChange(of: focus) { old, _ in
            if old == .path, let saved = page.settings.path { commitPath(saved) }
            if old == .checkpoint, let saved = page.settings.checkpoint { commitCheckpoint(saved) }
        }
        .confirmationDialog("Sign out of \(page.name)?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive, action: signOut)
        } message: { Text("The CLI on the computer signs out. Its conversations stay saved.") }
    }

    private func problemLine(_ text: String) -> some View {
        Text(text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.StatusText.failed)
            .transition(.opacity)
    }
    private func syncFields() {
        path = page.settings.path ?? ""
        checkpoint = page.settings.checkpoint ?? ""
    }
    private func commitPath(_ saved: String) {
        guard path.trimmingCharacters(in: .whitespaces) != saved else { pathProblem = nil; return }
        save(["kind": "path", "value": path]) { pathProblem = $0 }
    }
    private func commitCheckpoint(_ saved: String) {
        guard checkpoint.trimmingCharacters(in: .whitespaces) != saved else { checkpointProblem = nil; return }
        save(["kind": "checkpoint", "value": checkpoint]) { checkpointProblem = $0 }
    }
    /// `field` takes a refusal for the row it is about; without one it shows under the section.
    private func save(_ change: [String: Any], field: ((String?) -> Void)? = nil) {
        saving = true; problem = nil
        Task {
            defer { saving = false }
            do {
                try await model.editProvider(page.provider, change)
                withAnimation(.smooth) { field?(nil) }
                saved()
                model.refreshMachine()
            } catch {
                withAnimation(.smooth) {
                    if let field { field(error.localizedDescription) } else { problem = error.localizedDescription }
                }
            }
        }
    }
    private func signOut() {
        signingOut = true; signOutResult = nil; problem = nil
        Task {
            defer { signingOut = false }
            do {
                var progress = try await model.service(["type": "provider.logout", "provider": page.provider], as: LoginReply.self)
                guard progress.result.ok, var current = progress.result.progress else { throw ServiceFailure(message: progress.result.error.map(signOutRefusal) ?? "Couldn't sign out. Try again.") }
                for _ in 0..<60 where !current.finished {
                    try await Task.sleep(for: .seconds(1))
                    progress = try await model.service(["type": "provider.login.poll", "session": current.session], as: LoginReply.self)
                    guard let next = progress.result.progress else { break }
                    current = next
                }
                signOutResult = current.state == "succeeded" ? "Signed out." : (current.message ?? "Sign-out didn't finish. Try again in a terminal on the computer.")
                model.refreshMachine()
            } catch { problem = error.localizedDescription }
        }
    }
    private func signOutRefusal(_ code: String) -> String {
        code == "forbidden" ? "This phone isn't allowed to sign out providers on this computer." : "Couldn't sign out. Try again."
    }
}
