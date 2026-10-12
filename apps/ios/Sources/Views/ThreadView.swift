import SwiftUI

struct ThreadView: View {
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
                            .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 8, trailing: 20))
                    }
                }
                ForEach(model.pending.values.filter { $0.threadId == thread.id && $0.state != "delivered" && thread.items["input:\($0.id)"] == nil }.sorted { $0.id < $1.id }) { row in
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(row.text).font(.body).padding(12).background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: 16))
                        Text(row.state == "failed" ? "Send needs attention" : row.state == "accepted" ? "Accepted" : row.state == "saving" ? "Saving on your phone…" : "Sends on reconnect")
                            .font(.caption2).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }.frame(maxWidth: .infinity, alignment: .trailing).listRowSeparator(.hidden)
                }
                Color.clear.frame(height: 1).id("tail").listRowSeparator(.hidden)
            }
            .listStyle(.plain).scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("transcript")
            .onChange(of: thread.loaded) { _, loaded in
                if loaded && !scrolledToTail { proxy.scrollTo("tail", anchor: .bottom); scrolledToTail = true }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    ForEach(thread.approvals) { approval in
                        if approval.kind == "approval" { ApprovalCard(approval: approval) { model.approve(approval, option: $0) } }
                    }
                    ComposerView(state: metadata?.state ?? "new", modelName: metadata?.model ?? "", canSteer: metadata?.canSteer ?? false,
                                 send: { model.send($0, delivery: $1) }, stop: { model.stopTree() }, inputBegan: { model.metrics?.inputBegan() })
                }
            }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(metadata?.title ?? "Thread").font(.subheadline.weight(.semibold)).lineLimit(1)
                        Text("\(metadata?.project ?? "") · \(metadata?.machine ?? "") · \(metadata?.provider.capitalized ?? "")")
                            .font(.caption2).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(showWork ? "Collapse work" : "Expand work", systemImage: "list.bullet.rectangle") { withAnimation(.spring) { showWork.toggle() } }
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
                    Text("\(thread.items.count) items · \(model.connection)").font(.caption2.monospaced())
                        .padding(4).background(.thinMaterial, in: Capsule()).allowsHitTesting(false)
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
            VStack(alignment: row.role == "user" ? .trailing : .leading, spacing: 5) {
                Text(row.text).font(.body).lineSpacing(3).textSelection(.enabled)
                    .padding(row.role == "user" ? 12 : 0)
                    .background(row.role == "user" ? AceTheme.Colours.fill : .clear, in: RoundedRectangle(cornerRadius: 17))
                if row.truncated { Text("Showing a bounded preview").font(.caption2).foregroundStyle(AceTheme.Colours.mutedForeground) }
                if !row.complete { StateLabel(state: "working") }
            }.frame(maxWidth: .infinity, alignment: row.role == "user" ? .trailing : .leading)
        } else {
            HStack {
                Image(systemName: row.type == "tool_call" ? "wrench.and.screwdriver" : "text.alignleft")
                Text(expanded ? row.text : row.type == "tool_call" ? row.text : "Worked · \(row.type.replacingOccurrences(of: "_", with: " "))").lineLimit(expanded ? nil : 1)
                Spacer(minLength: 0)
                Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption2)
            }.font(.footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
        }
    }
}
