#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// The workspace's agents, what they are doing, and which one new issues go to.
struct AgentsView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @AppStorage("defaultAgentId") private var defaultAgent = ""
    @State private var agents: [Agent] = []
    @State private var loaded = false

    private var issues: [Issue] {
        session.offline.cachedIssues(workspaceSlug: credential.workspaceSlug, state: nil)
    }

    var body: some View {
        Form {
            if agents.isEmpty {
                Section {
                    Text(loaded ? "No agents are connected to this workspace." : "Loading").foregroundStyle(Theme.inkMuted)
                }
            } else {
                Section {
                    ForEach(agents) { agent in
                        NavigationLink { AgentActivityView(agent: agent, issues: issues.filter { $0.assigneeId == agent.id }) } label: {
                            row(agent)
                        }
                    }
                }
                Section {
                    Picker("Default agent", selection: $defaultAgent) {
                        Text("None").tag("")
                        ForEach(agents) { Text($0.name).tag($0.id) }
                    }
                } footer: {
                    Text("New issues start assigned to this agent. You can change it on any issue.")
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Agents")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            agents = (try? await session.client?.agents(ws: credential.workspaceSlug)) ?? []
            loaded = true
        }
    }

    private func row(_ agent: Agent) -> some View {
        let mine = issues.filter { $0.assigneeId == agent.id }
        let working = mine.filter { $0.state == .inProgress }.count
        let last = mine.map(\.updatedAt).max()
        return HStack(spacing: 10) {
            Glint(pulsing: working > 0)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name).foregroundStyle(Theme.ink)
                Group {
                    if working > 0 {
                        Text("Working on \(working)")
                    } else if let last {
                        Text("Last active \(last.formatted(.relative(presentation: .named)))")
                    } else {
                        Text(agent.harness ?? "Idle")
                    }
                }
                .font(.footnote)
                .foregroundStyle(Theme.inkMuted)
            }
        }
    }
}

/// An agent's issues on this phone, newest first.
struct AgentActivityView: View {
    let agent: Agent
    let issues: [Issue]

    var body: some View {
        List(issues.sorted { $0.updatedAt > $1.updatedAt }) { issue in
            IssueRowView(issue: issue)
        }
        .overlay {
            if issues.isEmpty {
                ContentUnavailableView("No recent work", systemImage: "moon.zzz", description: Text("\(agent.name) has no issues on this phone."))
            }
        }
        .navigationTitle(agent.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
#endif
