import { describe, expect, it } from "vitest";
import {
  buildScenarioMatrix,
  describeRestoreImpact,
  recheckScenario,
  saveScenario,
} from "../src/features/scenarios/scenarioViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type ScenarioSnapshot,
  type SimulationMode,
} from "../src/shared/domain/types";

function snapshotOf(
  project: LatencyProject,
  name: string,
  mode: SimulationMode = "expected",
): ScenarioSnapshot {
  const saved = saveScenario(project, simulateProject(project, mode), name);
  const snapshot = saved.scenarios[0];
  if (!snapshot) throw new Error("Scenario fixture should be saved");
  return snapshot;
}

const baseProject: LatencyProject = {
  ...EXAMPLE_PROJECT,
  nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
};

const brokenSnapshot: ScenarioSnapshot = {
  id: "broken",
  name: "成环链路",
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

describe("scenario matrix", () => {
  it("ranks comparable snapshots and marks best and worst", () => {
    const fast = snapshotOf(
      {
        ...baseProject,
        nodes: baseProject.nodes.map((node) => ({
          ...node,
          durationMs: 100,
          jitterMs: 0,
        })),
      },
      "快方案",
    );
    const slow = snapshotOf(
      {
        ...baseProject,
        nodes: baseProject.nodes.map((node) => ({
          ...node,
          durationMs: 900,
          jitterMs: 0,
        })),
      },
      "慢方案",
    );
    const matrix = buildScenarioMatrix({
      ...baseProject,
      scenarios: [slow, fast],
    });
    expect(matrix.comparable).toBe(true);
    expect(matrix.cautions).toHaveLength(0);
    expect(matrix.bestId).toBe(fast.id);
    expect(matrix.worstId).toBe(slow.id);
    expect(matrix.rankableIds).toHaveLength(2);
  });

  it("withholds best and worst when node sets differ", () => {
    const twoNodes = snapshotOf(baseProject, "两节点");
    const threeNodes = snapshotOf(
      { ...baseProject, nodes: EXAMPLE_PROJECT.nodes.slice(0, 3) },
      "三节点",
    );
    const matrix = buildScenarioMatrix({
      ...baseProject,
      scenarios: [twoNodes, threeNodes],
    });
    expect(matrix.comparable).toBe(false);
    expect(matrix.bestId).toBeUndefined();
    expect(matrix.worstId).toBeUndefined();
    expect(matrix.cautions.join(" ")).toContain("节点集合");
  });

  it("withholds best and worst when snapshots use different jitter modes", () => {
    const low = snapshotOf(baseProject, "低波动", "low");
    const high = snapshotOf(baseProject, "高波动", "high");
    const matrix = buildScenarioMatrix({
      ...baseProject,
      scenarios: [low, high],
    });
    expect(matrix.comparable).toBe(false);
    expect(matrix.bestId).toBeUndefined();
    expect(matrix.cautions.join(" ")).toContain("波动假设");
  });

  it("excludes snapshots that can no longer be simulated from ranking", () => {
    const good = snapshotOf(baseProject, "好方案");
    expect(recheckScenario(brokenSnapshot).ok).toBe(false);
    const matrix = buildScenarioMatrix({
      ...baseProject,
      scenarios: [good, brokenSnapshot],
    });
    expect(matrix.rankableIds).toEqual([good.id]);
    expect(matrix.invalidIds).toEqual([brokenSnapshot.id]);
    expect(matrix.bestId).toBeUndefined();
    expect(matrix.cautions.join(" ")).toContain("无法复算");
  });

  it("summarizes per-row differences against the current graph", () => {
    const changed = snapshotOf(
      {
        ...baseProject,
        nodes: [
          ...baseProject.nodes.map((node, index) =>
            index === 0 ? { ...node, durationMs: 999 } : node,
          ),
          { ...baseProject.nodes[0]!, id: "extra", name: "额外请求" },
        ],
      },
      "加节点",
    );
    const matrix = buildScenarioMatrix({
      ...baseProject,
      scenarios: [changed],
    });
    const row = matrix.rows[0];
    expect(row?.changedParamsVsCurrent).toBe(1);
    expect(row?.addedNodesVsCurrent).toBe(1);
    expect(row?.removedNodesVsCurrent).toBe(0);
  });
});

describe("restore impact", () => {
  it("lists removed nodes, changed params and concurrency changes", () => {
    const snapshot = snapshotOf(
      {
        ...baseProject,
        concurrencyLimit: 2,
        nodes: baseProject.nodes.map((node, index) =>
          index === 0 ? { ...node, durationMs: 999 } : node,
        ),
      },
      "旧方案",
    );
    const current: LatencyProject = {
      ...baseProject,
      concurrencyLimit: null,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 3),
      scenarios: [snapshot],
    };
    const impact = describeRestoreImpact(current, snapshot.id);
    expect(impact?.identical).toBe(false);
    expect(impact?.removedNodeNames).toEqual([EXAMPLE_PROJECT.nodes[2]?.name]);
    expect(impact?.addedNodeNames).toEqual([]);
    expect(impact?.changedParamCount).toBe(1);
    expect(impact?.concurrencyFrom).toBeNull();
    expect(impact?.concurrencyTo).toBe(2);
  });

  it("marks an identical snapshot as a no-op restore", () => {
    const snapshot = snapshotOf(baseProject, "一致方案");
    const current: LatencyProject = { ...baseProject, scenarios: [snapshot] };
    const impact = describeRestoreImpact(current, snapshot.id);
    expect(impact?.identical).toBe(true);
    expect(impact?.changedParamCount).toBe(0);
  });
});
