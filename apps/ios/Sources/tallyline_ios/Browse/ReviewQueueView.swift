#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// Review queue: `in_review` issues waiting for a human decision.
struct ReviewQueueView: View {
    var session: SessionModel
    let credential: DeviceCredential
    private var entries: [ReviewQueueEntry] { session.workspace.review }

    @Environment(\.horizontalSizeClass) private var sizeClass
    @SceneStorage("selectedReviewKey") private var selectedKey: String?

    var body: some View {
        if sizeClass == .regular {
            NavigationSplitView {
                content(selection: $selectedKey)
            } detail: {
                if let key = selectedKey {
                    NavigationStack { IssueLoaderView(session: session, credential: credential, key: key) }.id(key)
                } else {
                    ContentUnavailableView("Select an item", systemImage: "checkmark.circle", description: Text("Pick one to review it."))
                }
            }
        } else {
            NavigationStack {
                content(selection: .constant(nil))
                    .navigationDestination(for: ReviewQueueEntry.self) { entry in
                        IssueLoaderView(session: session, credential: credential, key: entry.key)
                    }
            }
        }
    }

    private func content(selection: Binding<String?>) -> some View {
        Group {
            if entries.isEmpty {
                ContentUnavailableView("Queue clear", systemImage: "checkmark.circle", description: Text("Work agents finish lands here for your call."))
            } else if sizeClass == .regular {
                List(entries, selection: selection) { entry in
                    ReviewRow(entry: entry).tag(entry.key).hoverEffect(.highlight)
                }
            } else {
                List(entries) { entry in
                    NavigationLink(value: entry) { ReviewRow(entry: entry) }
                }
            }
        }
        .navigationTitle("Review")
        .toolbar { ProfileToolbarItem(session: session) }
        .refreshable { await session.refresh() }
    }
}

/// One review row: the issue and which agent's session put it there.
struct ReviewRow: View {
    let entry: ReviewQueueEntry

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            StateGlyph(state: .inReview).padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(entry.key).font(.caption.monospaced()).foregroundStyle(Theme.inkSubtle)
                    Glint()
                    Text(entry.agentName).font(.caption).foregroundStyle(Theme.inkMuted)
                }
                Text(entry.title).font(.body).foregroundStyle(Theme.ink).lineLimit(4)
                HStack(spacing: 8) {
                    PriorityGlyph(priority: entry.priority)
                    Text(entry.sessionAt, format: .relative(presentation: .numeric, unitsStyle: .abbreviated))
                        .font(.caption2)
                        .foregroundStyle(Theme.inkSubtle)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(entry.key), \(entry.title), in review from \(entry.agentName)")
    }
}
#endif
