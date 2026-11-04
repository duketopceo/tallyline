#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// What the preview row and the root view read. One place for the keys.
enum AppearanceKey {
    static let theme = "appearance"
    static let density = "density"
    static let glintReduced = "glintReduced"
    static let reduceMotion = "reduceAppMotion"
    static let pulse = "pulseAnimation"
}

struct AppearanceView: View {
    @AppStorage(AppearanceKey.theme) private var theme = SilverLiningAppearance.system.rawValue
    @AppStorage(AppearanceKey.density) private var density = Density.comfortable.rawValue
    @AppStorage(AppearanceKey.glintReduced) private var glintReduced = false
    @AppStorage(AppearanceKey.reduceMotion) private var reduceMotion = false
    @AppStorage(AppearanceKey.pulse) private var pulse = true

    var body: some View {
        Form {
            Section {
                IssueRowView(issue: .appearanceSample)
                    .environment(\.density, Density(rawValue: density) ?? .comfortable)
                    .environment(\.glintReduced, glintReduced)
            } header: {
                Text("Preview")
            }
            Section {
                Picker("Theme", selection: $theme) {
                    ForEach(SilverLiningAppearance.allCases, id: \.rawValue) { Text($0.label).tag($0.rawValue) }
                }
                Picker("Density", selection: $density) {
                    ForEach(Density.allCases, id: \.rawValue) { Text($0.label).tag($0.rawValue) }
                }
            } footer: {
                Text("Compact fits more rows on screen by trimming their spacing.")
            }
            Section {
                Toggle("Grey agent marker", isOn: $glintReduced)
            } footer: {
                Text("Draws the agent star in grey instead of its colour.")
            }
            Section {
                Toggle("Reduce app motion", isOn: $reduceMotion)
                Toggle("Pulse animation", isOn: $pulse)
            } header: {
                Text("Motion")
            } footer: {
                Text("Tallyline already follows the system Reduce Motion setting. These only add to it: fades instead of springs, and a still agent marker.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private extension Issue {
    static let appearanceSample = Issue(
        id: "sample", key: "ENG-42", number: 42, title: "Retry the webhook delivery when the endpoint times out", description: nil,
        state: .inReview, priority: .high, estimate: nil, dueDate: nil, assigneeType: "agent", assigneeId: "a",
        delegateType: nil, delegateId: nil, creatorType: "agent", creatorId: nil, projectId: nil, cycleId: nil, parentId: nil,
        source: "web", occurrenceCount: 2, createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date().addingTimeInterval(-3600)
    )
}
#endif
