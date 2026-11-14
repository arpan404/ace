import SwiftUI

/// Codex's tool folder, as web's Codex page has it: the folder its accounts take plugins,
/// marketplaces and MCP servers from, the reason it adds nothing when it can't, Change… to type
/// another full path, and Use default once one is chosen. The bridge checks the path and says why
/// it can't be saved.
struct ProviderToolSourceSection: View {
    let model: ClientModel
    let page: ProviderPageData
    let source: ProviderPageData.ToolSource
    let saved: () -> Void
    @State private var typing = false
    @State private var typed = ""
    @State private var problem: String?
    @State private var saving = false

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text("Plugins and tools from").font(AceDesign.Typeface.body)
                Text(source.path).font(AceDesign.Typeface.meta).monospaced()
                    .foregroundStyle(AceDesign.Ink.muted).textSelection(.enabled)
                    .accessibilityIdentifier("provider.toolSource.path")
                if let reason = source.reason {
                    Text(reason).font(AceDesign.Typeface.meta).foregroundStyle(AceTheme.StatusText.needsYou)
                        .accessibilityIdentifier("provider.toolSource.reason")
                }
            }
            .padding(.vertical, AceDesign.Space.tight)
            if page.settings.editable {
                Button("Change…") { typed = source.path; typing = true }
                    .frame(minHeight: AceDesign.Size.tap)
                    .accessibilityIdentifier("provider.toolSource.change")
                if source.chosen {
                    Button("Use default") { save(nil) }
                        .frame(minHeight: AceDesign.Size.tap)
                        .accessibilityIdentifier("provider.toolSource.default")
                }
            }
            ServiceProblem(message: problem)
        } header: { InsetHeader("\(page.name)'s own tools") } footer: {
            if let locked = page.settings.locked { Text(locked) }
        }
        .insetRowBackground()
        .disabled(saving || !model.canOperate)
        .alert("Take Codex's plugins and tools from", isPresented: $typing) {
            TextField("Folder path", text: $typed)
                .monospaced().textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                .accessibilityIdentifier("provider.toolSource.field")
            Button("Cancel", role: .cancel) {}
            Button("Use folder") { save(typed) }
        } message: { Text("The folder's full path on the computer.") }
    }

    private func save(_ path: String?) {
        saving = true; problem = nil
        Task {
            defer { saving = false }
            do {
                try await model.editProvider(page.provider, ["kind": "toolSource", "path": path.map { $0 as Any } ?? NSNull()])
                saved()
                model.refreshMachine()
            } catch { withAnimation { problem = error.localizedDescription } }
        }
    }
}
