#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// Search tab: matches the issues already on the phone by key or title, so it
/// works offline and needs no new API.
struct SearchView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var query = ""

    private var results: [Issue] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        return session.offline.cachedIssues(workspaceSlug: credential.workspaceSlug, state: nil)
            .filter { $0.key.lowercased().contains(q) || $0.title.lowercased().contains(q) }
            .prefix(100)
            .map { $0 }
    }

    var body: some View {
        NavigationStack {
            Group {
                if query.isEmpty {
                    ContentUnavailableView("Search issues", systemImage: "magnifyingglass", description: Text("Find an issue by key or title."))
                } else if results.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    List(results) { issue in
                        NavigationLink(value: issue) { IssueRow(issue: issue) }
                    }
                }
            }
            .navigationTitle("Search")
            .navigationDestination(for: Issue.self) { issue in
                IssueDetailView(session: session, credential: credential, issue: issue)
            }
            .searchable(text: $query, prompt: "Key or title")
            .toolbar { ProfileToolbarItem(session: session) }
        }
    }
}
#endif
