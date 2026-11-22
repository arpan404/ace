import SwiftUI

/// One group's tabs in a line over its file: the file showing on a flat fill (in full ink while
/// the group is the focused one), a dot on a file with unsaved changes, a close button on each.
/// A tab's menu splits it right or moves it to the other group, and a tab can be dragged to the
/// editor's right edge or onto the other group.
struct EditorTabStrip: View {
    let group: EditorGroupLayout.Group
    let focused: Bool
    let unsaved: Set<String>
    let other: Bool
    let canSplit: (String) -> Bool
    let activate: (String) -> Void
    let split: (String) -> Void
    /// Closes these tabs; one with unsaved changes asks first.
    let close: ([String]) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: AceTheme.Spacing.xs) {
                    ForEach(group.tabs, id: \.self) { path in
                        tab(path)
                            .contextMenu { menu(path) }
                            .draggable(path) { Text(FileActions.name(path)).aceMonospace(AceDesign.TextRole.rowTitle) }
                            .id(path)
                    }
                }
                .padding(.horizontal, AceTheme.Spacing.sm)
            }
            .onChange(of: group.active, initial: true) { _, path in withAnimation { proxy.scrollTo(path) } }
        }
        .frame(height: AceDesign.Size.tap)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Open files")
    }

    private func tab(_ path: String) -> some View {
        let shown = path == group.active
        let name = FileActions.name(path)
        let changed = unsaved.contains(path)
        return HStack(spacing: AceTheme.Spacing.none) {
            Button { activate(path) } label: {
                HStack(spacing: AceTheme.Spacing.xs) {
                    Text(name)
                        .aceMonospace(AceTheme.Typography.caption, relativeTo: .subheadline)
                        .foregroundStyle(shown && focused ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                        .lineLimit(1)
                    if changed {
                        Circle().fill(AceTheme.Colours.foreground)
                            .frame(width: AceDesign.Size.dotSmall, height: AceDesign.Size.dotSmall)
                    }
                }
                .padding(.leading, AceTheme.Spacing.md)
                .padding(.trailing, AceTheme.Spacing.xs)
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(name)
            .accessibilityValue(changed ? "Unsaved changes" : "")
            .accessibilityAddTraits(shown ? .isSelected : [])
            .accessibilityIdentifier("editor.tab.\(path)")
            Button { close([path]) } label: {
                AceIcon(.x, size: AceDesign.Size.caret).foregroundStyle(AceTheme.Colours.subtleForeground)
                    .frame(width: AceDesign.Size.pill, height: AceDesign.Size.pill)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.trailing, AceTheme.Spacing.xs)
            .accessibilityLabel("Close \(name)")
            .accessibilityIdentifier("editor.tab.\(path).close")
        }
        .frame(height: AceDesign.Size.pill)
        .background { if shown { AceDesign.Shape.control.fill(AceTheme.Colours.fill) } }
        .contentShape(AceDesign.Shape.control)
        .frame(height: AceDesign.Size.tap)
        .contentShape(Rectangle())
        .hoverEffect(.highlight)
    }

    @ViewBuilder private func menu(_ path: String) -> some View {
        if other {
            Button("Move to other group", ace: .arrowsLeftRight) { split(path) }
        } else {
            Button("Split right", ace: .sidebarSimple) { split(path) }.disabled(!canSplit(path))
        }
        Button("Close", ace: .x) { close([path]) }
        Button("Close others", ace: .xSquare) { close(group.tabs.filter { $0 != path }) }
            .disabled(group.tabs.count < 2)
    }
}
