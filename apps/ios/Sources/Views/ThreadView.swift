import SwiftUI

struct ThreadView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    @State private var showWork = false
    @State private var showDetails = false
    @State private var scrolledToTail = false
    private var metadata: ThreadRow? { thread.metadata ?? model.inbox[thread.id] }
    var body: some View {
        ScrollViewReader { proxy in
            List {
                if !thread.loaded { ProgressView("Loading conversation…").listRowSeparator(.hidden) }
                ForEach(thread.order, id: \.self) { id in
                    if let item = thread.items[id] {
                        TranscriptItemView(item: item, expanded: showWork)
                            .id(id).listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.sm, leading: AceTheme.Spacing.xl, bottom: AceTheme.Spacing.sm, trailing: AceTheme.Spacing.xl))
                    }
                }
                ForEach(model.pending.values.filter { $0.threadId == thread.id && $0.state != "delivered" && thread.items["input:\($0.id)"] == nil }.sorted { $0.id < $1.id }) { row in
                    VStack(alignment: .trailing, spacing: AceTheme.Spacing.xs) {
                        Text(row.text).aceFont(AceTheme.Typography.body, relativeTo: .body).padding(AceTheme.Spacing.md).background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.bubble))
                        Text(row.state == "failed" ? "Send needs attention" : row.state == "accepted" ? "Accepted" : row.state == "saving" ? "Saving on your phone…" : "Sends on reconnect")
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }.frame(maxWidth: .infinity, alignment: .trailing).listRowSeparator(.hidden)
                }
                Color.clear.frame(height: AceTheme.Dimensions.border).id("tail").listRowSeparator(.hidden)
            }
            .listStyle(.plain).scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("transcript")
            .onChange(of: thread.loaded) { _, loaded in
                if loaded && !scrolledToTail { proxy.scrollTo("tail", anchor: .bottom); scrolledToTail = true }
            }
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
                VStack(spacing: AceTheme.Spacing.none) {
                    ForEach(thread.approvals) { approval in
                        if approval.kind == "approval" { ApprovalCard(approval: approval, submission: model.approvalSubmissions[approval.id]) { model.approve(approval, option: $0) } }
                    }
                    ComposerView(state: metadata?.state ?? "new", modelName: metadata?.model ?? "", canSteer: metadata?.canSteer ?? false,
                                 send: { await model.send($0, delivery: $1) }, stop: { model.stopTree() }, inputBegan: { model.metrics?.inputBegan() })
                }
            }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(metadata?.title ?? "Thread").aceFont(AceTheme.Typography.title, relativeTo: .headline).lineLimit(1)
                        Text("\(metadata?.project ?? "") · \(metadata?.machine ?? "") · \(metadata?.provider.capitalized ?? "")")
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(showWork ? "Collapse work" : "Expand work", systemImage: "list.bullet.rectangle") { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { showWork.toggle() } }
                        Button("Connection details", systemImage: "network") { showDetails = true }
                    } label: { Image(systemName: "ellipsis") }.accessibilityLabel("Thread options")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showDetails) {
                NavigationStack {
                    Form { LabeledContent("Connection", value: model.connection); LabeledContent("Items", value: thread.items.count.formatted()); StateLabel(state: metadata?.state ?? "new") }
                        .navigationTitle("Thread").navigationBarTitleDisplayMode(.inline)
                }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
            #if DEBUG
            .overlay(alignment: .topLeading) {
                if SpikeConfiguration.enabled {
                    Text(verbatim: "\(thread.items.count) items · \(model.connection)").aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .padding(AceTheme.Spacing.xs).background(.thinMaterial, in: Capsule()).allowsHitTesting(false)
                        .accessibilityLabel("Loaded transcript").accessibilityValue(String(thread.items.count))
                        .accessibilityIdentifier("spike.loaded")
                }
            }
            #endif
        }
    }
}
private struct TranscriptItemView: View {
    @Bindable var item: ItemModel
    let expanded: Bool
    var body: some View {
        let row = item.row
        if row.type == "message" {
            VStack(alignment: row.role == "user" ? .trailing : .leading, spacing: AceTheme.Spacing.xs) {
                Text(row.text).aceFont(AceTheme.Typography.body, relativeTo: .body).textSelection(.enabled)
                    .padding(row.role == "user" ? AceTheme.Spacing.md : AceTheme.Spacing.none)
                    .background(row.role == "user" ? AceTheme.Colours.fill : .clear, in: RoundedRectangle(cornerRadius: AceTheme.Radii.bubble))
                if row.truncated { Text("Showing a bounded preview").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
            }.frame(maxWidth: .infinity, alignment: row.role == "user" ? .trailing : .leading)
        } else if row.type == "html" {
            // The sandboxed renderer is desktop/web only; show what was published and where to see it.
            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                Image(systemName: "chart.bar.doc.horizontal")
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(row.text).foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                    Text("Visualization — view on desktop or web")
                }
                Spacer(minLength: AceTheme.Spacing.none)
            }.aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            .accessibilityElement(children: .combine)
        } else {
            HStack(spacing: AceTheme.Spacing.sm) {
                Image(systemName: row.type == "tool_call" ? "wrench.and.screwdriver" : "text.alignleft")
                Text(expanded ? row.text : row.type == "tool_call" ? row.text : "Worked · \(row.type.replacingOccurrences(of: "_", with: " "))").lineLimit(expanded ? nil : 1)
                Spacer(minLength: AceTheme.Spacing.none)
                Image(systemName: expanded ? "chevron.down" : "chevron.right").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            }.aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
        }
    }
}
