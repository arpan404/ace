import SwiftUI

/// Settings › Task profiles: saved instructions a new thread's first message can carry.
struct TaskProfilesView: View {
    let store: TaskProfileStore
    @State private var profiles: [TaskProfile] = []
    @State private var problem: String?
    var body: some View {
        List {
            Section {
                ServiceProblem(message: problem)
                ForEach(profiles) { profile in
                    NavigationLink { TaskProfileEditor(store: store, profile: profile) } label: { SettingsRow(profile.name) }
                }
                .onDelete { indices in
                    do { for index in indices { try store.remove(profiles[index].id) }; profiles = store.load() }
                    catch { problem = error.localizedDescription }
                }
                NavigationLink { TaskProfileEditor(store: store, profile: TaskProfile(id: UUID().uuidString, name: "", instructions: "")) } label: {
                    SettingsRow(title: "New profile") { Image(systemName: "plus").foregroundStyle(AceTheme.Colours.subtleForeground) }
                }
            } header: { SettingsHeader("Profiles", note: "Included in the first message of new threads that use them.") }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Task profiles").navigationBarTitleDisplayMode(.inline)
        .onAppear { profiles = store.load() }
    }
}
private struct TaskProfileEditor: View {
    let store: TaskProfileStore
    @State var profile: TaskProfile
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            Section {
                TextField("Profile name", text: $profile.name).aceFont(SettingsStyle.label, relativeTo: .body)
            } header: { SettingsHeader("Name") }
            .settingsRow()
            Section {
                TextEditor(text: $profile.instructions)
                    .aceFont(SettingsStyle.label, relativeTo: .body)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget * 5).accessibilityLabel("Profile instructions")
                ServiceProblem(message: problem)
            } header: {
                SettingsHeader("Instructions", note: "Existing threads keep the instructions they started with.")
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle(profile.name.isEmpty ? "New profile" : profile.name).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    do { try store.save(profile); dismiss() } catch { problem = error.localizedDescription }
                }
                .disabled(profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("profile.save")
            }
        }
    }
}
