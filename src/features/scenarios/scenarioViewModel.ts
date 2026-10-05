import type {
  LatencyProject,
  RequestNode,
  ScenarioSnapshot,
  SimulationResult,
} from "../../shared/domain/types";
import { simulateProject } from "../../shared/domain/simulation";

export interface ScenarioComparison {
  deltaMs: number;
  changes: string[];
  outcome: "faster" | "slower" | "equal";
}

function describeNodeChanges(
  before: RequestNode,
  after: RequestNode,
): string[] {
  const changes: string[] = [];
  if (before.durationMs !== after.durationMs)
    changes.push(
      `${before.name} · 耗时 ${before.durationMs} → ${after.durationMs} ms`,
    );
  if (before.jitterMs !== after.jitterMs)
    changes.push(
      `${before.name} · 波动 ±${before.jitterMs} → ±${after.jitterMs} ms`,
    );
  if (before.timeoutMs !== after.timeoutMs)
    changes.push(
      `${before.name} · 超时 ${before.timeoutMs} → ${after.timeoutMs} ms`,
    );
  if (before.retryCount !== after.retryCount)
    changes.push(
      `${before.name} · 重试 ${before.retryCount} → ${after.retryCount} 次`,
    );
  if (before.failureRate !== after.failureRate)
    changes.push(
      `${before.name} · 失败率 ${before.failureRate} → ${after.failureRate}%`,
    );
  if (before.fallbackNodeId !== after.fallbackNodeId)
    changes.push(`${before.name} · 降级目标已调整`);
  if (before.dependencyIds.join("|") !== after.dependencyIds.join("|"))
    changes.push(`${before.name} · 前置依赖已调整`);
  return changes;
}

export function compareScenarios(
  baseline: ScenarioSnapshot,
  comparison: ScenarioSnapshot,
): ScenarioComparison {
  const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, node]));
  const comparisonNodes = new Map(
    comparison.nodes.map((node) => [node.id, node]),
  );
  const changes = [
    ...baseline.nodes.flatMap((node) => {
      const next = comparisonNodes.get(node.id);
      return next
        ? describeNodeChanges(node, next)
        : [`${node.name} · 已从对照方案移除`];
    }),
    ...comparison.nodes
      .filter((node) => !baselineNodes.has(node.id))
      .map((node) => `${node.name} · 新增请求节点`),
  ];
  if (baseline.concurrencyLimit !== comparison.concurrencyLimit)
    changes.unshift(
      `并发上限 · ${baseline.concurrencyLimit ?? "不限"} → ${comparison.concurrencyLimit ?? "不限"}`,
    );
  return {
    deltaMs: comparison.completionMs - baseline.completionMs,
    changes,
    outcome:
      comparison.completionMs < baseline.completionMs
        ? "faster"
        : comparison.completionMs > baseline.completionMs
          ? "slower"
          : "equal",
  };
}

export function saveScenario(
  project: LatencyProject,
  result: SimulationResult,
  name: string,
): LatencyProject {
  if (
    result.warnings.some(
      (warning) => warning.includes("检测到循环") || warning.includes("不能"),
    )
  )
    return project;
  const snapshot: ScenarioSnapshot = {
    id: crypto.randomUUID(),
    name: name.trim() || `方案 ${project.scenarios.length + 1}`,
    createdAt: Date.now(),
    concurrencyLimit: project.concurrencyLimit,
    nodes: structuredClone(project.nodes),
    completionMs: result.completionMs,
    criticalPath: [...result.criticalPath],
    mode: result.mode,
  };
  return {
    ...project,
    scenarios: [snapshot, ...project.scenarios],
    updatedAt: Date.now(),
  };
}

export function removeScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  return {
    ...project,
    scenarios: project.scenarios.filter(
      (scenario) => scenario.id !== scenarioId,
    ),
    updatedAt: Date.now(),
  };
}

export function restoreScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  const snapshot = project.scenarios.find(
    (scenario) => scenario.id === scenarioId,
  );
  if (!snapshot) return project;
  return {
    ...project,
    nodes: structuredClone(snapshot.nodes),
    concurrencyLimit: snapshot.concurrencyLimit,
    updatedAt: Date.now(),
  };
}

export interface ScenarioRecheck {
  ok: boolean;
  errors: string[];
}

/** 用当前推演规则复算快照，判断存档链路现在是否还能得出结果。 */
export function recheckScenario(scenario: ScenarioSnapshot): ScenarioRecheck {
  const result = simulateProject(
    {
      id: `recheck-${scenario.id}`,
      title: scenario.name,
      nodes: scenario.nodes,
      concurrencyLimit: scenario.concurrencyLimit,
      scenarios: [],
      createdAt: scenario.createdAt,
      updatedAt: scenario.createdAt,
    },
    scenario.mode ?? "expected",
  );
  const failed = result.entries.length !== scenario.nodes.length;
  return { ok: !failed, errors: failed ? result.warnings : [] };
}

export interface ScenarioMatrixRow {
  scenario: ScenarioSnapshot;
  recheck: ScenarioRecheck;
  /** 与当前链路共有节点上发生变化的参数条数 */
  changedParamsVsCurrent: number;
  /** 快照有而当前链路没有的节点数 */
  addedNodesVsCurrent: number;
  /** 当前链路有而快照没有的节点数 */
  removedNodesVsCurrent: number;
  criticalPathNames: string[];
}

export interface ScenarioMatrix {
  rows: ScenarioMatrixRow[];
  /** 复算通过、可参与排序的方案 id */
  rankableIds: string[];
  /** 复算失败的方案 id，不参与排序 */
  invalidIds: string[];
  bestId?: string;
  worstId?: string;
  /** 为 false 时排序仅供参考，不应标注最优/最差 */
  comparable: boolean;
  cautions: string[];
}

function nodeSetKey(scenario: ScenarioSnapshot): string {
  return scenario.nodes
    .map((node) => node.id)
    .sort()
    .join("|");
}

export function buildScenarioMatrix(project: LatencyProject): ScenarioMatrix {
  const currentIds = new Set(project.nodes.map((node) => node.id));
  const currentById = new Map(project.nodes.map((node) => [node.id, node]));
  const rows: ScenarioMatrixRow[] = project.scenarios.map((scenario) => {
    const snapshotIds = new Set(scenario.nodes.map((node) => node.id));
    const changedParamsVsCurrent = scenario.nodes.reduce((count, node) => {
      const current = currentById.get(node.id);
      return current
        ? count + describeNodeChanges(current, node).length
        : count;
    }, 0);
    const namesById = new Map(
      scenario.nodes.map((node) => [node.id, node.name]),
    );
    return {
      scenario,
      recheck: recheckScenario(scenario),
      changedParamsVsCurrent,
      addedNodesVsCurrent: scenario.nodes.filter(
        (node) => !currentIds.has(node.id),
      ).length,
      removedNodesVsCurrent: project.nodes.filter(
        (node) => !snapshotIds.has(node.id),
      ).length,
      criticalPathNames: scenario.criticalPath.map(
        (id) => namesById.get(id) ?? id,
      ),
    };
  });

  const rankableIds = rows
    .filter((row) => row.recheck.ok)
    .map((row) => row.scenario.id);
  const invalidIds = rows
    .filter((row) => !row.recheck.ok)
    .map((row) => row.scenario.id);

  const cautions: string[] = [];
  if (invalidIds.length)
    cautions.push(
      `${invalidIds.length} 份方案的链路当前无法复算，已排除在排序之外。`,
    );

  const rankableRows = rows.filter((row) => row.recheck.ok);
  const distinctNodeSets = new Set(
    rankableRows.map((row) => nodeSetKey(row.scenario)),
  );
  const distinctModes = new Set(
    rankableRows
      .map((row) => row.scenario.mode)
      .filter((mode) => mode !== undefined),
  );
  let comparable = true;
  if (distinctNodeSets.size > 1) {
    comparable = false;
    cautions.push(
      "所选方案的节点集合不一致，完成预算不直接可比；排序仅供参考，不标注最优与最差。",
    );
  }
  if (distinctModes.size > 1) {
    comparable = false;
    cautions.push(
      "方案保存时使用了不同的波动假设，完成预算不直接可比；排序仅供参考，不标注最优与最差。",
    );
  }

  let bestId: string | undefined;
  let worstId: string | undefined;
  if (comparable && rankableRows.length >= 2) {
    const budgets = rankableRows.map((row) => row.scenario.completionMs);
    const min = Math.min(...budgets);
    const max = Math.max(...budgets);
    if (min !== max) {
      bestId = rankableRows.find((row) => row.scenario.completionMs === min)
        ?.scenario.id;
      worstId = rankableRows.find((row) => row.scenario.completionMs === max)
        ?.scenario.id;
    }
  }
  return {
    rows,
    rankableIds,
    invalidIds,
    bestId,
    worstId,
    comparable,
    cautions,
  };
}

export interface RestoreImpact {
  scenario: ScenarioSnapshot;
  /** 恢复后将从当前链路移除的节点名 */
  removedNodeNames: string[];
  /** 恢复后将加入当前链路的节点名 */
  addedNodeNames: string[];
  /** 共有节点上将被覆盖的参数条数 */
  changedParamCount: number;
  concurrencyFrom: number | null;
  concurrencyTo: number | null;
  /** 快照与当前链路完全一致时为 true */
  identical: boolean;
}

/** 恢复前说明：这次恢复会覆盖当前链路的哪些内容。 */
export function describeRestoreImpact(
  project: LatencyProject,
  scenarioId: string,
): RestoreImpact | undefined {
  const snapshot = project.scenarios.find(
    (scenario) => scenario.id === scenarioId,
  );
  if (!snapshot) return undefined;
  const snapshotIds = new Set(snapshot.nodes.map((node) => node.id));
  const currentIds = new Set(project.nodes.map((node) => node.id));
  const snapshotById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const changedParamCount = project.nodes.reduce((count, node) => {
    const next = snapshotById.get(node.id);
    return next ? count + describeNodeChanges(node, next).length : count;
  }, 0);
  const removedNodeNames = project.nodes
    .filter((node) => !snapshotIds.has(node.id))
    .map((node) => node.name);
  const addedNodeNames = snapshot.nodes
    .filter((node) => !currentIds.has(node.id))
    .map((node) => node.name);
  const identical =
    removedNodeNames.length === 0 &&
    addedNodeNames.length === 0 &&
    changedParamCount === 0 &&
    project.concurrencyLimit === snapshot.concurrencyLimit;
  return {
    scenario: snapshot,
    removedNodeNames,
    addedNodeNames,
    changedParamCount,
    concurrencyFrom: project.concurrencyLimit,
    concurrencyTo: snapshot.concurrencyLimit,
    identical,
  };
}
