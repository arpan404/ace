import SwiftUI
import UIKit

/// The file's bar: the navigation bar's title and buttons, or in an iPad editor group beside
/// another (`EditorSlot.pane`), the same title and buttons as one row over the file.
extension FileScreen {
    var inPane: Bool { slot?.pane == true }

    /// The file's name, and under it the folders it sits in.
    func titleStack(alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: AceTheme.Spacing.none) {
            Text(name).aceMonospace(AceDesign.TextRole.rowTitle).lineLimit(1)
            // Not while editing: a folder would leave the unsaved text.
            FileBreadcrumbs(path: path) { open($0) }.disabled(editing)
        }
    }

    @ToolbarContentBuilder var viewToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            OpenFilesButton(model: model, scope: scope) { picked in switchTo(picked) }
            viewButtons
        }
    }

    @ViewBuilder var viewButtons: some View {
        if showsSource {
            Button("Find in file", ace: .magnifyingGlass) { handle.find() }.accessibilityIdentifier("file.find")
        }
        if canEdit {
            Button("Edit", ace: .pencilSimple) { editing = true }.accessibilityIdentifier("file.edit")
        } else if canEditParts, content?.kind == "text" {
            // Over 1 MB: shown in parts, each with its own Edit.
            Button(inParts ? "Done" : "Edit in parts", ace: inParts ? .check : .pencilSimple) { inParts.toggle() }
                .accessibilityIdentifier("file.editParts")
        }
        Menu { fileMenu } label: { Label("File options", ace: .dotsThree) }
            .accessibilityIdentifier("file.menu")
    }

    /// The bar as a row over the file, in an editor group beside another.
    var paneBar: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if editing {
                cancelButton
                editingLabel
                Spacer(minLength: AceTheme.Spacing.sm)
                findWhileEditing.labelStyle(.iconOnly).frame(minWidth: AceDesign.Size.tap, minHeight: AceDesign.Size.tap)
                saveButton
            } else {
                titleStack(alignment: .leading)
                Spacer(minLength: AceTheme.Spacing.sm)
                viewButtons.labelStyle(.iconOnly).frame(minWidth: AceDesign.Size.tap, minHeight: AceDesign.Size.tap)
            }
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, AceDesign.Space.margin)
        .frame(minHeight: AceDesign.Size.tap)
        .background(AceTheme.Colours.background)
    }

    /// This file on the computer, for Open in.
    var hostTarget: HostOpenTarget {
        switch scope {
        case .thread(let id): HostOpenTarget(threadId: id, path: path, line: target.line)
        case .project(let id): HostOpenTarget(workspaceId: id, path: path, line: target.line)
        }
    }
    @ViewBuilder var fileMenu: some View {
        if text != nil, !markdownPreview { Toggle(isOn: $wrap) { Label("Wrap lines", ace: .textAlignLeft) } }
        if showsSource {
            Button("Go to line", ace: .arrowBendDownRight) { goingToLine = true }.accessibilityIdentifier("file.goToLine")
        }
        if content?.markdown == true {
            Button(source ? "View preview" : "View source", ace: source ? .eye : .code) { source.toggle() }
        }
        if hasChanges { Button("Show changes", ace: .plusMinus) { showChanges = true }.accessibilityIdentifier("file.changes") }
        if let mention { Button("Mention in message", ace: .at) { mention(ComposerMention(path: path)) }.accessibilityIdentifier("preview.mention") }
        if let split = slot?.split {
            Button(split.label, ace: split.icon) { split.run() }.disabled(!split.enabled)
                .accessibilityIdentifier("file.split")
        }
        Button("Copy path", ace: .copy) { UIPasteboard.general.string = path }
        if content?.kind != "missing" {
            OpenOnHostMenu(model: model, target: hostTarget) { Label("Open in…", ace: .arrowSquareOut) }
                .accessibilityIdentifier("file.openIn")
        }
        if content != nil, content?.kind != "missing" { Button("Share", ace: .export) { shareFile() } }
        if actions.canChange, content?.kind != "missing" {
            Divider()
            Button("Rename", ace: .pencilSimple) { actions.ask(.rename(path: path)) }
            Button("Move", ace: .folder) { actions.ask(.move(path: path)) }
            Button("Delete", ace: .trash, role: .destructive) { actions.ask(.delete(path: path)) }
        }
    }

    @ToolbarContentBuilder var editToolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) { cancelButton }
        ToolbarItem(placement: .principal) { editingLabel }
        ToolbarItem(placement: .topBarTrailing) { findWhileEditing }
        ToolbarItem(placement: .confirmationAction) { saveButton }
    }

    var cancelButton: some View {
        Button("Cancel") {
            // A pending auto save must not write what the person may be about to discard.
            autoSaveTask?.cancel()
            autoSaveTask = nil
            if dirty { confirmDiscard = true } else { stopEditing() }
        }.disabled(saving)
            .accessibilityIdentifier("file.cancel")
    }
    var editingLabel: some View {
        Text(dirty ? "Unsaved changes" : "Editing").aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
    }
    var findWhileEditing: some View { Button("Find", ace: .magnifyingGlass) { handle.find() } }
    var saveButton: some View {
        Button(saving ? "Saving…" : "Save") { save() }.fontWeight(.semibold).disabled(!dirty || saving)
            .accessibilityIdentifier("file.save")
    }
}
