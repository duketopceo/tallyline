#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// One project: the ring and counts up top, its issues grouped by state.
struct ProjectDetailView: View {
    var session: SessionModel
    let credential: DeviceCredential
    let project: Project

    private var counts: RoadmapSummary.ProjectCounts {
        session.workspace.summary?.counts(forProject: project.id)
            ?? RoadmapSummary.ProjectCounts(projectId: project.id, total: 0, done: 0, closed: 0, inProgress: 0, inReview: 0, doneSince: nil)
    }

    private var issues: [Issue] {
        session.offline.cachedIssues(workspaceSlug: credential.workspaceSlug, state: nil)
            .filter { $0.projectId == project.id }
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 16) {
                    ProgressRing(done: counts.done, total: counts.total)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(counts.done) of \(counts.total) done").font(.headline).foregroundStyle(Theme.ink)
                        Text("\(counts.inProgress) in progress · \(counts.inReview) in review")
                            .font(.footnote)
                            .foregroundStyle(Theme.inkMuted)
                    }
                }
                if let description = project.description, !description.isEmpty {
                    Text(description).font(.body).foregroundStyle(Theme.inkMuted).textSelection(.enabled)
                }
            }
            if issues.isEmpty {
                Section {
                    Text("No issues in this project on this phone yet.")
                        .font(.footnote)
                        .foregroundStyle(Theme.inkMuted)
                }
            }
            ForEach(IssueGrouping.sections(issues), id: \.state) { section in
                Section {
                    ForEach(section.issues) { issue in
                        NavigationLink(value: issue) { IssueRowView(issue: issue) }
                    }
                } header: {
                    Text(section.state.displayName).font(.footnote.smallCaps()).foregroundStyle(Theme.inkMuted)
                }
            }
        }
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await session.refresh() }
    }
}
#endif
