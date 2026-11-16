#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// The app root: active projects, a compact agents-working strip, and a way
/// to create the first project. Issues stay on their own tab.
struct HomeView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var showCreate = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var workspace: WorkspaceModel { session.workspace }

    private var cards: [HomeProjectCard] {
        HomeOverview.cards(projects: workspace.projects, summary: workspace.summary, fetchedAt: workspace.fetchedAt)
    }

    private var working: [HomeWorkingItem] {
        HomeOverview.workingAgents(in: session.offline.cachedIssues(workspaceSlug: credential.workspaceSlug, state: nil))
    }

    var body: some View {
        NavigationStack {
            Group {
                if cards.isEmpty {
                    ContentUnavailableView {
                        Label("No active projects", systemImage: "square.stack.3d.up")
                    } description: {
                        Text("Projects group issues toward a goal. Create one to see it here.")
                    } actions: {
                        Button("New project") { showCreate = true }
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    List {
                        if !working.isEmpty {
                            Section {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 8) {
                                        ForEach(working) { item in
                                            Text(item.line)
                                                .font(.caption.weight(.medium))
                                                .foregroundStyle(Theme.ink)
                                                .padding(.horizontal, 10)
                                                .padding(.vertical, 6)
                                                .background(Theme.surface3, in: Capsule())
                                                .accessibilityLabel(item.line)
                                        }
                                    }
                                    .padding(.vertical, 2)
                                }
                                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                                .listRowSeparator(.hidden)
                                .accessibilityElement(children: .contain)
                                .accessibilityLabel(workingHeader)
                            } header: {
                                Text(workingHeader)
                                    .font(.footnote.smallCaps())
                                    .foregroundStyle(Theme.inkMuted)
                            }
                        }
                        Section {
                            ForEach(cards) { card in
                                if let project = workspace.projects.first(where: { $0.id == card.id }) {
                                    NavigationLink(value: project) { HomeProjectCardView(card: card, stacked: dynamicTypeSize.isAccessibilitySize) }
                                } else {
                                    HomeProjectCardView(card: card, stacked: dynamicTypeSize.isAccessibilitySize)
                                }
                            }
                        }
                    }
                    .motion(.standard, value: cards.map(\.id))
                }
            }
            .navigationTitle("Home")
            .navigationDestination(for: Project.self) { project in
                ProjectDetailView(session: session, credential: credential, project: project)
            }
            .navigationDestination(for: Issue.self) { issue in
                IssueDetailView(session: session, credential: credential, issue: issue)
            }
            .toolbar {
                ProfileToolbarItem(session: session)
                ToolbarItem(placement: .primaryAction) {
                    Button { showCreate = true } label: { Label("New project", systemImage: "plus") }
                }
            }
            .refreshable { await session.refresh() }
            .sheet(isPresented: $showCreate) { CreateProjectView(session: session, credential: credential) }
        }
    }

    private var workingHeader: String {
        let count = working.count
        return "\(count) agent\(count == 1 ? "" : "s") working"
    }
}

/// Progress ring, open counts, and the last activity line. Stacks at AX sizes
/// so the ring and text do not clip.
struct HomeProjectCardView: View {
    let card: HomeProjectCard
    var stacked = false

    var body: some View {
        let content = Group {
            if stacked {
                VStack(alignment: .leading, spacing: 12) {
                    ProgressRing(done: card.done, total: card.total)
                    texts
                }
            } else {
                HStack(alignment: .top, spacing: 12) {
                    ProgressRing(done: card.done, total: card.total)
                    texts
                }
            }
        }
        content
            .padding(.vertical, 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(card.accessibilityLabel())
    }

    private var texts: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(card.name).font(.body).foregroundStyle(Theme.ink).lineLimit(stacked ? 4 : 2)
            Text(openLine)
                .font(.caption)
                .foregroundStyle(Theme.inkMuted)
            if let activity = card.lastActivity {
                Text(activity.displayText())
                    .font(.caption2)
                    .foregroundStyle(Theme.inkSubtle)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var openLine: String {
        var parts = ["\(card.openCount) open"]
        if card.inProgress > 0 { parts.append("\(card.inProgress) in progress") }
        if card.inReview > 0 { parts.append("\(card.inReview) in review") }
        return parts.joined(separator: " · ")
    }
}

#Preview("Home cards") {
    List {
        HomeProjectCardView(card: .previewKate)
        HomeProjectCardView(card: .previewIdle)
    }
}

#Preview("Home cards, largest text") {
    List {
        HomeProjectCardView(card: .previewKate, stacked: true)
        HomeProjectCardView(card: .previewIdle, stacked: true)
    }
    .dynamicTypeSize(.accessibility5)
}

private extension HomeProjectCard {
    static var previewKate: HomeProjectCard {
        HomeProjectCard(
            id: "k", name: "Kate", done: 4, total: 10, openCount: 6, inProgress: 2, inReview: 1,
            lastActivity: HomeActivityLine(sentence: "Builder finished KATE-1", at: Date().addingTimeInterval(-200))
        )
    }

    static var previewIdle: HomeProjectCard {
        HomeProjectCard(id: "i", name: "Idle", done: 0, total: 0, openCount: 0, inProgress: 0, inReview: 0, lastActivity: nil)
    }
}
#endif
