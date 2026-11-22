import Testing
@testable import Ace

@Suite struct EditorDraftsTests {
    /// `a.swift` being edited from version v1, with "typed" as its text once its editor went away.
    private func edited(_ path: String = "a.swift") -> EditorDrafts {
        var drafts = EditorDrafts()
        drafts.begin(path, base: "v1")
        drafts.mark(path, dirty: true, base: "v1")
        return drafts
    }

    @Test func anEditedFileMovedToTheOtherGroupKeepsItsDraft() {
        var layout = EditorGroupLayout()
        for path in ["a.swift", "b.swift", "c.swift"] { layout.open(path) }
        layout.split("c.swift")
        var drafts = edited()
        // a.swift's editor goes away as it moves; the one in the other group picks the draft up.
        layout.move("a.swift", to: layout.groups[1].id)
        drafts.left("a.swift", text: "typed")
        #expect(drafts["a.swift"] == EditorDraft(base: "v1", text: "typed", dirty: true))
        #expect(layout.groups[1].active == "a.swift")
        #expect(drafts.editing)
    }

    @Test func anEditedFileInAGroupCompactWidthHidesKeepsItsDraft() {
        var layout = EditorGroupLayout()
        for path in ["a.swift", "b.swift"] { layout.open(path) }
        layout.split("b.swift")
        layout.focus(layout.groups[0].id)
        var drafts = edited("b.swift")
        // Compact width draws only the focused group, so b.swift's editor goes.
        #expect(layout.collapsed.shown == "a.swift")
        drafts.left("b.swift", text: "typed")
        #expect(drafts["b.swift"]?.text == "typed")
        // The editor can't be left while a draft waits, though no editor on screen is editing.
        #expect(drafts.editing)
    }

    @Test func closingAnEditedFileWaitsForThePersonWhileCleanOnesCloseAtOnce() {
        var drafts = edited()
        drafts.begin("b.swift", base: "v1")
        let closing = drafts.closing(["a.swift", "b.swift", "c.swift"])
        #expect(closing.now == ["b.swift", "c.swift"])
        #expect(closing.ask == ["a.swift"])
        // Closing drops the clean one's draft; the edited one stays until it is discarded.
        drafts.closed("b.swift")
        #expect(drafts["b.swift"] == nil)
        #expect(drafts["a.swift"] != nil)
    }

    @Test func aFileTheComputerClosedKeepsItsTabWhileItHasUnsavedChanges() {
        var layout = EditorGroupLayout()
        for path in ["a.swift", "b.swift"] { layout.open(path) }
        let drafts = edited()
        layout.sync(open: [], previous: ["a.swift", "b.swift"], keep: nil, held: drafts.unsaved)
        #expect(layout.groups.map(\.tabs) == [["a.swift"]])
        #expect(drafts["a.swift"]?.dirty == true)
    }

    @Test func anEditThatChangedNothingIsDroppedWhenItsEditorGoes() {
        var drafts = EditorDrafts()
        drafts.begin("a.swift", base: "v1")
        drafts.left("a.swift", text: "same")
        #expect(drafts["a.swift"] == nil)
        #expect(!drafts.editing)
    }

    @Test func anEditorThatCameBackToADroppedCleanDraftStartsItAgainOnceTypedInto() {
        var drafts = EditorDrafts()
        drafts.begin("a.swift", base: "v1")
        // The old editor goes after the new one appeared, unchanged: its draft is dropped.
        drafts.left("a.swift", text: "same")
        drafts.mark("a.swift", dirty: true, base: "v1")
        #expect(drafts["a.swift"] == EditorDraft(base: "v1", text: nil, dirty: true))
        // Turning clean again on a file with no draft makes none.
        drafts.mark("b.swift", dirty: false, base: "v1")
        #expect(drafts["b.swift"] == nil)
    }

    @Test func anEditKeepsTheVersionItBeganFrom() {
        var drafts = edited()
        // Beginning again (the editor came back) doesn't move the base to a newer version.
        drafts.begin("a.swift", base: "v2")
        #expect(drafts["a.swift"]?.base == "v1")
    }

    @Test func savingOrDiscardingEndsTheDraft() {
        var drafts = edited()
        drafts.end("a.swift")
        #expect(drafts["a.swift"] == nil)
        // An editor going after its draft ended doesn't bring it back.
        drafts.left("a.swift", text: "typed")
        #expect(drafts["a.swift"] == nil)
    }

    @Test func aRenamedFilesDraftFollowsIt() {
        var drafts = edited()
        drafts.rename("a.swift", to: "src/a.swift")
        #expect(drafts["a.swift"] == nil)
        #expect(drafts["src/a.swift"]?.dirty == true)
        #expect(drafts.unsaved == ["src/a.swift"])
    }
}
