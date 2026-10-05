import { analyzeGraph } from "../../shared/domain/graph";
import { simulateProject } from "../../shared/domain/simulation";
import type {
  LatencyProject,
  RequestNode,
  ScenarioSnapshot,
  SimulationMode,
  SimulationResult,
} from "../../shared/domain/types";

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

/* ---------- 方案对比矩阵 ---------- */

/** 矩阵最多并排展示的方案数，超出时需要用户自行挑选 */
export const MAX_MATRIX_COLUMNS = 6;
/** 重算预算与保存预算的容差，避免浮点误差误报 */
const STALE_TOLERANCE_MS = 0.5;
const MODE_FALLBACK_ORDER: SimulationMode[] = ["low", "expected", "high"];

export type ScenarioStatus = "ok" | "stale" | "invalid";

export interface ScenarioAssessment {
  scenario: ScenarioSnapshot;
  status: ScenarioStatus;
  /** 预算实际对应的波动假设 */
  mode: SimulationMode;
  /** 当前模型重算出的完成预算；invalid 时无意义 */
  completionMs: number;
  storedCompletionMs: number;
  criticalPath: string[];
  issues: string[];
}

function scenarioToProject(scenario: ScenarioSnapshot): LatencyProject {
  return {
    id: `scenario-${scenario.id}`,
    title: scenario.name,
    nodes: scenario.nodes,
    concurrencyLimit: scenario.concurrencyLimit,
    scenarios: [],
    createdAt: scenario.createdAt,
    updatedAt: scenario.createdAt,
  };
}

/**
 * 重新校验一份快照：链路已推演出结果的为 ok；
 * 保存的预算与当前模型重算不一致的为 stale（展示重算值）；
 * 链路本身已无法推演的为 invalid（不参与任何排序结论）。
 */
export function assessScenario(scenario: ScenarioSnapshot): ScenarioAssessment {
  const stored = scenario.completionMs;
  const fallbackMode = scenario.mode ?? "expected";
  const invalid = (issues: string[]): ScenarioAssessment => ({
    scenario,
    status: "invalid",
    mode: fallbackMode,
    completionMs: stored,
    storedCompletionMs: stored,
    criticalPath: [],
    issues,
  });
  if (!scenario.nodes.length) return invalid(["方案不包含任何请求节点"]);
  const project = scenarioToProject(scenario);
  const analysis = analyzeGraph(project);
  if (analysis.validation.errors.length)
    return invalid(analysis.validation.errors);

  const results = new Map<SimulationMode, SimulationResult>();
  const run = (mode: SimulationMode): SimulationResult => {
    const cached = results.get(mode);
    if (cached) return cached;
    const fresh = simulateProject(project, mode);
    results.set(mode, fresh);
    return fresh;
  };
  // 旧快照没有记录波动假设，依次尝试三种假设，任一匹配即视为一致
  const candidates = scenario.mode ? [scenario.mode] : MODE_FALLBACK_ORDER;
  const matchedMode = candidates.find(
    (mode) => Math.abs(run(mode).completionMs - stored) <= STALE_TOLERANCE_MS,
  );
  const mode = matchedMode ?? fallbackMode;
  const fresh = run(mode);
  const stale = matchedMode === undefined;
  return {
    scenario,
    status: stale ? "stale" : "ok",
    mode,
    completionMs: fresh.completionMs,
    storedCompletionMs: stored,
    criticalPath: fresh.criticalPath,
    issues: stale
      ? ["保存时的预算与当前模型重算结果不一致，已按重算值展示"]
      : [],
  };
}

export type MatrixSort = "budget-asc" | "budget-desc" | "recent";

export interface ScenarioMatrix {
  /** 参与展示的列：可推演方案按排序在前，无法推演的固定排在最后 */
  columns: ScenarioAssessment[];
  excluded: ScenarioAssessment[];
  bestIds: ReadonlySet<string>;
  worstIds: ReadonlySet<string>;
  rankableCount: number;
  budgetsTied: boolean;
  /** 各方案预算记录于不同波动假设，横向排序仅供对照 */
  modesDiffer: boolean;
}

export function buildScenarioMatrix(
  scenarios: ScenarioSnapshot[],
  sort: MatrixSort,
): ScenarioMatrix {
  const assessments = scenarios.map(assessScenario);
  const rankable = assessments.filter((item) => item.status !== "invalid");
  const excluded = assessments.filter((item) => item.status === "invalid");
  const budgets = rankable.map((item) => item.completionMs);
  const min = budgets.length ? Math.min(...budgets) : 0;
  const max = budgets.length ? Math.max(...budgets) : 0;
  const budgetsTied = rankable.length > 1 && min === max;
  const shouldMark = rankable.length > 1 && !budgetsTied;
  const bestIds = new Set(
    shouldMark
      ? rankable
          .filter((item) => item.completionMs === min)
          .map((item) => item.scenario.id)
      : [],
  );
  const worstIds = new Set(
    shouldMark
      ? rankable
          .filter((item) => item.completionMs === max)
          .map((item) => item.scenario.id)
      : [],
  );
  const sorted = [...rankable].sort((a, b) => {
    if (sort === "recent") return 0;
    const delta = a.completionMs - b.completionMs;
    return sort === "budget-asc" ? delta : -delta;
  });
  return {
    columns: [...sorted, ...excluded],
    excluded,
    bestIds,
    worstIds,
    rankableCount: rankable.length,
    budgetsTied,
    modesDiffer: new Set(rankable.map((item) => item.mode)).size > 1,
  };
}

export function defaultMatrixSelection(
  scenarios: ScenarioSnapshot[],
): string[] {
  return scenarios.slice(0, MAX_MATRIX_COLUMNS).map((scenario) => scenario.id);
}

export interface MatrixNodeCell {
  present: boolean;
  durationMs: number;
  jitterMs: number;
  timeoutMs: number;
  retryCount: number;
  /** 与行内首个包含该节点的方案参数不一致 */
  differs: boolean;
}

export interface MatrixNodeRow {
  nodeId: string;
  nodeName: string;
  cells: MatrixNodeCell[];
}

/** 取各方案节点集合的并集生成参数行；某方案没有的节点标记为 absent */
export function buildParameterRows(
  columns: ScenarioAssessment[],
): MatrixNodeRow[] {
  const scenarios = columns.map((column) => column.scenario);
  const ids: string[] = [];
  const names = new Map<string, string>();
  for (const scenario of scenarios) {
    for (const node of scenario.nodes) {
      if (!names.has(node.id)) {
        names.set(node.id, node.name);
        ids.push(node.id);
      }
    }
  }
  return ids.map((nodeId) => {
    const nodes = scenarios.map((scenario) =>
      scenario.nodes.find((node) => node.id === nodeId),
    );
    const reference = nodes.find((node): node is RequestNode => Boolean(node));
    const cells = nodes.map((node): MatrixNodeCell =>
      node
        ? {
            present: true,
            durationMs: node.durationMs,
            jitterMs: node.jitterMs,
            timeoutMs: node.timeoutMs,
            retryCount: node.retryCount,
            differs: Boolean(
              reference &&
              (node.durationMs !== reference.durationMs ||
                node.jitterMs !== reference.jitterMs ||
                node.timeoutMs !== reference.timeoutMs ||
                node.retryCount !== reference.retryCount),
            ),
          }
        : {
            present: false,
            durationMs: 0,
            jitterMs: 0,
            timeoutMs: 0,
            retryCount: 0,
            differs: false,
          },
    );
    return { nodeId, nodeName: names.get(nodeId) ?? nodeId, cells };
  });
}

export interface NodeSetSummary {
  shared: number;
  onlyBaseline: string[];
  onlyComparison: string[];
  union: number;
  /** 共同节点不足一半时，参数级对比的代表性有限 */
  divergent: boolean;
}

export function summarizeNodeSets(
  baseline: ScenarioSnapshot,
  comparison: ScenarioSnapshot,
): NodeSetSummary {
  const baselineIds = new Set(baseline.nodes.map((node) => node.id));
  const comparisonIds = new Set(comparison.nodes.map((node) => node.id));
  const shared = baseline.nodes.filter((node) =>
    comparisonIds.has(node.id),
  ).length;
  const onlyBaseline = baseline.nodes
    .filter((node) => !comparisonIds.has(node.id))
    .map((node) => node.name);
  const onlyComparison = comparison.nodes
    .filter((node) => !baselineIds.has(node.id))
    .map((node) => node.name);
  const union = shared + onlyBaseline.length + onlyComparison.length;
  return {
    shared,
    onlyBaseline,
    onlyComparison,
    union,
    divergent: union > 0 && shared / union < 0.5,
  };
}

export interface RestoreImpact {
  /** 当前链路有、快照没有，恢复后会被移除的节点名 */
  removed: string[];
  /** 快照有、当前链路没有，恢复后会新增的节点名 */
  added: string[];
  /** 两边都有但参数不一致，恢复后会被覆盖的节点名 */
  changed: string[];
  /** 完全一致的节点数 */
  kept: number;
  concurrencyFrom: number | null;
  concurrencyTo: number | null;
  /** 恢复不会改变任何内容 */
  identical: boolean;
}

export function describeRestoreImpact(
  project: LatencyProject,
  scenario: ScenarioSnapshot,
): RestoreImpact {
  const currentById = new Map(project.nodes.map((node) => [node.id, node]));
  const snapshotIds = new Set(scenario.nodes.map((node) => node.id));
  const removed = project.nodes
    .filter((node) => !snapshotIds.has(node.id))
    .map((node) => node.name);
  const added: string[] = [];
  const changed: string[] = [];
  let kept = 0;
  for (const node of scenario.nodes) {
    const current = currentById.get(node.id);
    if (!current) {
      added.push(node.name);
      continue;
    }
    if (current.name !== node.name || describeNodeChanges(current, node).length)
      changed.push(node.name);
    else kept += 1;
  }
  return {
    removed,
    added,
    changed,
    kept,
    concurrencyFrom: project.concurrencyLimit,
    concurrencyTo: scenario.concurrencyLimit,
    identical:
      !removed.length &&
      !added.length &&
      !changed.length &&
      project.concurrencyLimit === scenario.concurrencyLimit,
  };
}
