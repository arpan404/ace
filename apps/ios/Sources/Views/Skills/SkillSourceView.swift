import SwiftUI

/// One plugin skill, command or agent: what it does, which coding agents may use it, and its
/// source, edited through the same review as an install.
struct SkillSourceView: View {
    let model: ClientModel
    let component: PluginComponentRow
    @State private var source = ""
    @State private var original = ""
    @State private var hash: String?
    @State private var problem: String?
    @State private var editing = false
    @State private var loading = false
    @State private var enabled: Bool?
    @State private var providers: [String]?
    @State private var review: PluginReviewRequest?
    var body: some View {
        List {
            if !component.description.isEmpty {
                Section {
                    Text(component.description).aceFont(SettingsStyle.value, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                .settingsRow()
            }
            if component.kind == "skill", model.canOperate {
                Section {
                    Toggle(isOn: Binding(get: { enabled ?? component.skillAvailability?.enabled ?? component.enabled }, set: { on in availability(enabled: on, providers: providers ?? component.skillAvailability?.providers ?? component.providers) })) {
                        SettingsRow(title: "Enabled for new sessions") { EmptyView() }
                    }
                    ForEach(ProviderLabels.ids, id: \.self) { provider in
                        Toggle(isOn: Binding(get: { (providers ?? component.skillAvailability?.providers ?? component.providers).contains(provider) }, set: { on in
                            var selected = providers ?? component.skillAvailability?.providers ?? component.providers
                            selected.removeAll { $0 == provider }; if on { selected.append(provider) }
                            availability(enabled: enabled ?? component.skillAvailability?.enabled ?? component.enabled, providers: selected)
                        })) { SettingsRow(title: provider.capitalized) { EmptyView() } }
                    }
                } header: { SettingsHeader("Availability", note: "Which coding agents can use this skill in new sessions.") }
                .settingsRow()
            }
            if let problem, hash == nil {
                EmptyState(icon: nil, title: "Couldn't read the source", line: problem, failed: true) {
                    Button("Try again") { Task { await read() } }
                }
                .accessibilityIdentifier("service.problem")
                .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            } else if let problem {
                Section {
                    ServiceProblem(message: problem)
                    Button { Task { await read() } } label: { SettingsActionLabel(title: "Try again") }.buttonStyle(.plain)
                }
                .settingsRow()
            }
            if loading && hash == nil {
                Section {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                        ForEach([220, 260, 180, 240], id: \.self) { width in
                            Capsule().fill(AceTheme.Colours.fill).frame(width: CGFloat(width), height: 10)
                        }
                    }
                    .padding(.vertical, AceTheme.Spacing.xs)
                    .accessibilityElement(children: .ignore).accessibilityLabel("Reading source")
                } header: { SettingsHeader("Source") }
                .settingsRow()
            }
            if hash != nil {
                Section {
                    if editing {
                        TextEditor(text: $source).frame(minHeight: AceTheme.Dimensions.touchTarget * 5)
                            .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                            .scrollContentBackground(.hidden)
                        Button {
                            if let hash { review = PluginReviewRequest(operation: ["type": "plugins.edit", "name": component.plugin, "path": component.path, "expectedHash": hash, "text": source]) }
                        } label: { SettingsActionLabel(title: "Review changes") }
                        .buttonStyle(.plain)
                        .disabled(source == original || source.utf16.count > 262144)
                    } else {
                        MarkdownView(text: source)
                        if model.canOperate {
                            Button { editing = true } label: { SettingsActionLabel(title: "Edit source") }
                                .buttonStyle(.plain)
                                .disabled(source.utf16.count > 262144)
                        }
                    }
                } header: { SettingsHeader("Source") }
                .settingsRow()
            }
        }
        .settingsList()
        .navigationTitle(component.title ?? component.name).navigationBarTitleDisplayMode(.inline)
        .task { await read() }
        .sheet(item: $review) { PluginReviewView(model: model, request: $0, installed: { editing = false; Task { await read() } }) }
    }
    private func availability(enabled: Bool, providers: [String]) {
        Task {
            do {
                _ = try await model.plugin(["type": "plugins.skillAvailability", "plugin": component.plugin, "name": component.name, "enabled": enabled, "providers": providers], expecting: "plugins.skillAvailability")
                self.enabled = enabled; self.providers = providers; problem = nil
            } catch { problem = error.localizedDescription }
        }
    }
    private func read() async {
        loading = true; problem = nil
        defer { loading = false }
        do {
            var offset = 0
            var fingerprint: String?
            var parts: [String] = []
            for _ in 0..<66 {
                let page = try await model.plugin(["type": "plugins.source", "name": component.plugin, "path": component.path, "offset": offset], expecting: "plugins.source")
                guard let bytes = page.bytes, bytes <= 4 * 1024 * 1024, page.offset == offset,
                      let next = page.nextOffset, next <= bytes, let nextHash = page.hash, let text = page.text,
                      fingerprint == nil || fingerprint == nextHash else { throw ServiceFailure(message: "The source changed while reading. Refresh and try again.") }
                fingerprint = nextHash; parts.append(text)
                if next == bytes { original = parts.joined(); source = original; hash = nextHash; return }
                guard next > offset else { break }
                offset = next
            }
            throw ServiceFailure(message: "This source is too large to open on the phone.")
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

