import SwiftUI

/// The models this thread's account offers. Picking one switches the thread from its next turn.
struct ModelPickerSheet: View {
    @Bindable var screen: ThreadScreenModel
    let load: () -> Void
    let choose: (ModelOption) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var choosing: String?
    var body: some View {
        NavigationStack {
            List {
                switch screen.modelsState {
                case "ready" where screen.models.isEmpty:
                    ContentUnavailableView("No models listed", systemImage: "cpu", description: Text("Check this account on your machine."))
                case "ready":
                    ForEach(screen.models) { option in
                        Button {
                            choosing = option.id
                            Task {
                                if await choose(option) { dismiss() }
                                choosing = nil
                            }
                        } label: {
                            HStack(spacing: AceTheme.Spacing.md) {
                                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                                    Text(option.label).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                                    if !option.detail.isEmpty { Text(option.detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
                                }
                                Spacer(minLength: AceTheme.Spacing.none)
                                if choosing == option.id { ProgressView() }
                                else if option.current { Image(systemName: "checkmark").foregroundStyle(AceTheme.Colours.foreground) }
                            }.frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(choosing != nil || option.current)
                        .accessibilityAddTraits(option.current ? .isSelected : [])
                    }
                case "failed":
                    ContentUnavailableView {
                        Label("Couldn't load models", systemImage: "wifi.exclamationmark")
                    } description: { Text("Your machine didn't answer. Check the connection and try again.") } actions: {
                        Button("Try again", action: load)
                    }
                default:
                    HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden)
                }
            }
            .navigationTitle("Model").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        .onAppear(perform: load)
    }
}
