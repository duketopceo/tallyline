#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// An issue to open by key.
struct IssueKeyRoute: Hashable {
    let key: String
}

/// The first tab: what agents and people just did, and what needs you.
struct NowView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @Namespace private var zoom

    private var groups: [NowSection] {
        let workspace = session.workspace
        let items = NowFeed.items(
            merges: workspace.summary?.merges ?? [],
            review: workspace.review,
            outbox: session.offline.entries,
            fetchedAt: workspace.fetchedAt
        )
        return NowFeed.grouped(items)
    }

    var body: some View {
        NavigationStack {
            Group {
                if groups.isEmpty {
                    ContentUnavailableView("Quiet", systemImage: "moon.zzz", description: Text("Agent work and review requests show up here."))
                } else {
                    List {
                        ForEach(groups) { entry in
                            Section {
                                ForEach(entry.items) { item in row(item) }
                            } header: {
                                Text(entry.group.title)
                                    .font(.footnote.smallCaps())
                                    .foregroundStyle(entry.group == .needsYou ? Theme.urgent : Theme.inkMuted)
                            }
                        }
                    }
                    .motion(.standard, value: groups.flatMap(\.items).map(\.id))
                }
            }
            .navigationTitle("Now")
            .navigationDestination(for: IssueKeyRoute.self) { route in
                IssueLoaderView(session: session, credential: credential, key: route.key)
                    .navigationTransition(.zoom(sourceID: route.key, in: zoom))
            }
            .toolbar { ProfileToolbarItem(session: session) }
            .refreshable { await session.refresh() }
        }
    }

    @ViewBuilder
    private func row(_ item: NowItem) -> some View {
        let content = HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol(item))
                .foregroundStyle(item.kind == .parkedWrite ? Theme.urgent : Theme.inkMuted)
                .frame(width: 22)
                .padding(.top, 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if item.byAgent { Glint() }
                    Text(item.sentence).font(.body).foregroundStyle(Theme.ink)
                }
                HStack(spacing: 6) {
                    Text(item.at, format: .relative(presentation: .numeric, unitsStyle: .abbreviated))
                    if let asOf = item.asOf {
                        Text("· as of \(asOf.formatted(date: .omitted, time: .shortened))")
                    }
                }
                .font(.caption2)
                .foregroundStyle(Theme.inkSubtle)
            }
        }
        .accessibilityElement(children: .combine)

        if let key = item.issueKey {
            NavigationLink(value: IssueKeyRoute(key: key)) { content }
                .matchedTransitionSource(id: key, in: zoom)
        } else {
            content
        }
    }

    private func symbol(_ item: NowItem) -> String {
        switch item.kind {
        case .parkedWrite: "tray.and.arrow.up"
        case .reviewRequest: "checkmark.circle"
        case .finished(let pr): pr == nil ? "checkmark.circle.fill" : "arrow.triangle.merge"
        }
    }
}
#endif
