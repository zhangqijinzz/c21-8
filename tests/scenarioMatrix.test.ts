import { describe, expect, it } from "vitest";
import {
  MAX_MATRIX_COLUMNS,
  assessScenario,
  buildParameterRows,
  buildScenarioMatrix,
  defaultMatrixSelection,
  describeRestoreImpact,
  saveScenario,
  summarizeNodeSets,
} from "../src/features/scenarios/scenarioViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type ScenarioSnapshot,
} from "../src/shared/domain/types";

const baseProject: LatencyProject = {
  ...EXAMPLE_PROJECT,
  nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
};

function saveAs(
  project: LatencyProject,
  name: string,
  mode: "low" | "expected" | "high" = "expected",
): ScenarioSnapshot {
  const snapshot = saveScenario(project, simulateProject(project, mode), name)
    .scenarios[0];
  if (!snapshot) throw new Error("scenario fixture should be saved");
  return snapshot;
}

const cyclicSnapshot: ScenarioSnapshot = {
  id: "scenario-cyclic",
  name: "循环方案",
  createdAt: 1,
  concurrencyLimit: null,
  completionMs: 200,
  criticalPath: [],
  nodes: [
    {
      id: "a",
      name: "节点 A",
      durationMs: 100,
      jitterMs: 0,
      dependencyIds: ["b"],
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
    },
    {
      id: "b",
      name: "节点 B",
      durationMs: 100,
      jitterMs: 0,
      dependencyIds: ["a"],
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
    },
  ],
};

describe("scenario assessment", () => {
  it("marks a freshly saved snapshot as ok and records its mode", () => {
    const snapshot = saveAs(baseProject, "基准");
    expect(snapshot.mode).toBe("expected");
    const assessment = assessScenario(snapshot);
    expect(assessment.status).toBe("ok");
    expect(assessment.completionMs).toBe(snapshot.completionMs);
    expect(assessment.criticalPath.length).toBeGreaterThan(0);
  });

  it("flags a stored budget that no longer matches the model as stale", () => {
    const snapshot = saveAs(baseProject, "过期预算");
    const tampered = { ...snapshot, completionMs: snapshot.completionMs + 500 };
    const assessment = assessScenario(tampered);
    expect(assessment.status).toBe("stale");
    expect(assessment.completionMs).toBe(snapshot.completionMs);
    expect(assessment.storedCompletionMs).toBe(tampered.completionMs);
    expect(assessment.issues.length).toBeGreaterThan(0);
  });

  it("accepts legacy snapshots without a recorded mode", () => {
    const snapshot = saveAs(baseProject, "旧快照", "high");
    const legacy: ScenarioSnapshot = { ...snapshot };
    delete legacy.mode;
    expect(assessScenario(legacy).status).toBe("ok");
  });

  it("rejects snapshots whose chain can no longer be simulated", () => {
    const cyclic = assessScenario(cyclicSnapshot);
    expect(cyclic.status).toBe("invalid");
    expect(cyclic.issues.join(" ")).toContain("循环");
    const empty = assessScenario({
      ...cyclicSnapshot,
      id: "scenario-empty",
      nodes: [],
      completionMs: 0,
    });
    expect(empty.status).toBe("invalid");
  });
});

describe("scenario matrix ranking", () => {
  const fast = saveAs(baseProject, "并行");
  const slow = saveAs({ ...baseProject, concurrencyLimit: 1 }, "串行");

  it("marks the best and worst budgets and sorts by budget", () => {
    const matrix = buildScenarioMatrix([slow, fast], "budget-asc");
    expect(matrix.columns[0]?.scenario.id).toBe(fast.id);
    expect(matrix.bestIds.has(fast.id)).toBe(true);
    expect(matrix.worstIds.has(slow.id)).toBe(true);
    const descending = buildScenarioMatrix([slow, fast], "budget-desc");
    expect(descending.columns[0]?.scenario.id).toBe(slow.id);
    const recent = buildScenarioMatrix([slow, fast], "recent");
    expect(recent.columns.map((column) => column.scenario.id)).toEqual([
      slow.id,
      fast.id,
    ]);
  });

  it("excludes unsimulatable scenarios from ranking and pins them last", () => {
    const matrix = buildScenarioMatrix(
      [slow, cyclicSnapshot, fast],
      "budget-asc",
    );
    expect(matrix.excluded.map((item) => item.scenario.id)).toEqual([
      cyclicSnapshot.id,
    ]);
    expect(matrix.columns[2]?.scenario.id).toBe(cyclicSnapshot.id);
    expect(matrix.rankableCount).toBe(2);
    expect(matrix.bestIds.has(fast.id)).toBe(true);
  });

  it("avoids best/worst marks when budgets tie or too few scenarios rank", () => {
    const tied = buildScenarioMatrix(
      [saveAs(baseProject, "甲"), saveAs(baseProject, "乙")],
      "budget-asc",
    );
    expect(tied.budgetsTied).toBe(true);
    expect(tied.bestIds.size).toBe(0);
    expect(tied.worstIds.size).toBe(0);
    const single = buildScenarioMatrix([cyclicSnapshot, fast], "budget-asc");
    expect(single.rankableCount).toBe(1);
    expect(single.bestIds.size).toBe(0);
  });

  it("warns when budgets were recorded under different jitter modes", () => {
    const low = saveAs(EXAMPLE_PROJECT, "乐观", "low");
    const high = saveAs(EXAMPLE_PROJECT, "保守", "high");
    const matrix = buildScenarioMatrix([low, high], "budget-asc");
    expect(matrix.modesDiffer).toBe(true);
    expect(matrix.bestIds.has(low.id)).toBe(true);
  });

  it("caps the default matrix selection", () => {
    let project: LatencyProject = { ...EXAMPLE_PROJECT, scenarios: [] };
    for (let index = 0; index < MAX_MATRIX_COLUMNS + 2; index += 1)
      project = saveScenario(
        project,
        simulateProject(project),
        `方案 ${index}`,
      );
    expect(project.scenarios.length).toBe(MAX_MATRIX_COLUMNS + 2);
    expect(defaultMatrixSelection(project.scenarios)).toHaveLength(
      MAX_MATRIX_COLUMNS,
    );
  });
});

describe("matrix parameter rows and node set summary", () => {
  const snapshotA = saveAs(baseProject, "原始");
  const projectB: LatencyProject = {
    ...EXAMPLE_PROJECT,
    nodes: [
      { ...EXAMPLE_PROJECT.nodes[0]!, durationMs: 500 },
      {
        ...EXAMPLE_PROJECT.nodes[2]!,
        id: "profile-copy",
        dependencyIds: ["session"],
      },
    ],
  };
  const snapshotB = saveAs(projectB, "改结构");

  it("unions node sets across scenarios and marks absent or differing cells", () => {
    const matrix = buildScenarioMatrix([snapshotA, snapshotB], "recent");
    const rows = buildParameterRows(matrix.columns);
    expect(rows.map((row) => row.nodeId)).toEqual([
      "session",
      "flags",
      "profile-copy",
    ]);
    const session = rows[0]!;
    expect(session.cells[0]?.differs).toBe(false);
    expect(session.cells[1]?.differs).toBe(true);
    expect(rows[1]?.cells[0]?.present).toBe(true);
    expect(rows[1]?.cells[1]?.present).toBe(false);
    expect(rows[2]?.cells[0]?.present).toBe(false);
    expect(rows[2]?.cells[1]?.present).toBe(true);
  });

  it("summarizes node set overlap and flags divergent structures", () => {
    const summary = summarizeNodeSets(snapshotA, snapshotB);
    expect(summary.shared).toBe(1);
    expect(summary.onlyBaseline).toEqual(["功能开关"]);
    expect(summary.onlyComparison).toEqual(["用户资料"]);
    expect(summary.divergent).toBe(true);
    const identical = summarizeNodeSets(snapshotA, snapshotA);
    expect(identical.divergent).toBe(false);
    expect(identical.shared).toBe(2);
  });
});

describe("restore impact", () => {
  it("describes removed, added and changed nodes plus concurrency shift", () => {
    const snapshot = saveAs(
      { ...baseProject, concurrencyLimit: 2 },
      "目标方案",
    );
    const changed = {
      ...baseProject,
      nodes: baseProject.nodes.map((node, index) =>
        index === 0 ? { ...node, durationMs: 999 } : node,
      ),
    };
    const impact = describeRestoreImpact(changed, snapshot);
    expect(impact.removed).toEqual([]);
    expect(impact.added).toEqual([]);
    expect(impact.changed).toEqual(["会话校验"]);
    expect(impact.kept).toBe(1);
    expect(impact.concurrencyFrom).toBeNull();
    expect(impact.concurrencyTo).toBe(2);
    expect(impact.identical).toBe(false);
  });

  it("reports node removal and addition when structures differ", () => {
    const snapshot = saveAs(baseProject, "两节点");
    const current: LatencyProject = {
      ...baseProject,
      nodes: [EXAMPLE_PROJECT.nodes[2]!],
    };
    const impact = describeRestoreImpact(current, snapshot);
    expect(impact.removed).toEqual(["用户资料"]);
    expect(impact.added).toEqual(["会话校验", "功能开关"]);
    expect(impact.identical).toBe(false);
  });

  it("detects when the current chain already matches the snapshot", () => {
    const snapshot = saveAs(baseProject, "一致");
    const impact = describeRestoreImpact(baseProject, snapshot);
    expect(impact.identical).toBe(true);
    expect(impact.kept).toBe(2);
  });
});
