import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  GitCompareArrows,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type {
  LatencyProject,
  ScenarioSnapshot,
  SimulationMode,
} from "../../shared/domain/types";
import {
  MAX_MATRIX_COLUMNS,
  buildParameterRows,
  buildScenarioMatrix,
  defaultMatrixSelection,
  describeRestoreImpact,
  summarizeNodeSets,
  type MatrixSort,
  type ScenarioComparison,
} from "./scenarioViewModel";

interface Props {
  project: LatencyProject;
  canSaveCurrent: boolean;
  onSave: (name: string) => boolean;
  onRemove: (id: string) => void;
  onRestore: (id: string) => void;
  baseline?: ScenarioSnapshot;
  comparison?: ScenarioSnapshot;
  comparisonResult?: ScenarioComparison;
  onSelectBaseline: (id: string) => void;
  onSelectComparison: (id: string) => void;
}

const MODE_LABELS: Record<SimulationMode, string> = {
  low: "乐观",
  expected: "预期",
  high: "保守",
};

const PARAM_ROW_LIMIT = 6;

function formatDuration(value: number): string {
  return value < 1000
    ? `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(2)} s`;
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function concurrencyLabel(limit: number | null): string {
  return limit ? `${limit} 路并发` : "不限并发";
}

function joinNames(names: string[]): string {
  return names.length <= 4
    ? names.join("、")
    : `${names.slice(0, 4).join("、")} 等 ${names.length} 个`;
}

export default function ScenarioPanel({
  project,
  canSaveCurrent,
  onSave,
  onRemove,
  onRestore,
  baseline,
  comparison,
  comparisonResult,
  onSelectBaseline,
  onSelectComparison,
}: Props) {
  const [name, setName] = useState("");
  const [sort, setSort] = useState<MatrixSort>("budget-asc");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [pendingRestoreId, setPendingRestoreId] = useState<string | null>(null);

  const matrix = useMemo(
    () => buildScenarioMatrix(project.scenarios, sort),
    [project.scenarios, sort],
  );
  const assessmentById = useMemo(
    () => new Map(matrix.columns.map((item) => [item.scenario.id, item])),
    [matrix],
  );
  const pickedIds = useMemo(() => {
    if (picked === null) return defaultMatrixSelection(project.scenarios);
    return picked.filter((id) =>
      project.scenarios.some((scenario) => scenario.id === id),
    );
  }, [picked, project.scenarios]);
  const selectedColumns = useMemo(
    () =>
      matrix.columns.filter((column) => pickedIds.includes(column.scenario.id)),
    [matrix, pickedIds],
  );
  const paramRows = useMemo(
    () => buildParameterRows(selectedColumns),
    [selectedColumns],
  );

  const baselineAssessment = baseline
    ? assessmentById.get(baseline.id)
    : undefined;
  const comparisonAssessment = comparison
    ? assessmentById.get(comparison.id)
    : undefined;
  const bothRankable = Boolean(
    baselineAssessment &&
    comparisonAssessment &&
    baselineAssessment.status !== "invalid" &&
    comparisonAssessment.status !== "invalid",
  );
  const delta =
    bothRankable && baselineAssessment && comparisonAssessment
      ? comparisonAssessment.completionMs - baselineAssessment.completionMs
      : 0;
  const nodeSetSummary =
    baseline && comparison
      ? summarizeNodeSets(baseline, comparison)
      : undefined;
  const changes = comparisonResult?.changes ?? [];

  const pendingScenario = project.scenarios.find(
    (scenario) => scenario.id === pendingRestoreId,
  );
  const pendingImpact = pendingScenario
    ? describeRestoreImpact(project, pendingScenario)
    : undefined;
  const pendingAssessment = pendingScenario
    ? assessmentById.get(pendingScenario.id)
    : undefined;

  const togglePicked = (id: string) => {
    setPicked(
      pickedIds.includes(id)
        ? pickedIds.filter((item) => item !== id)
        : [...pickedIds, id],
    );
  };
  const confirmRestore = () => {
    if (pendingScenario) onRestore(pendingScenario.id);
    setPendingRestoreId(null);
  };
  const backupThenRestore = () => {
    if (!pendingScenario) return;
    if (onSave(`恢复前备份 · ${pendingScenario.name}`)) {
      onRestore(pendingScenario.id);
      setPendingRestoreId(null);
    }
  };

  const visibleParamRows = paramRows.slice(0, PARAM_ROW_LIMIT);
  const hiddenParamRows = paramRows.length - visibleParamRows.length;

  return (
    <section className="module-page scenarios-page">
      <div className="module-heading">
        <div>
          <span className="eyebrow">04 / SCENARIOS</span>
          <h1>方案对比</h1>
          <p>保存关键参数快照，用对比矩阵判断一次调整是否真的缩短了等待。</p>
        </div>
      </div>
      <div className="save-scenario-bar">
        <div className="save-icon">
          <GitCompareArrows size={18} />
        </div>
        <div className="save-prompt">
          <strong>将当前推演保存为方案</strong>
          <small>保留节点、依赖、并发策略与完成预算。</small>
        </div>
        <input
          className="scenario-name-input"
          placeholder={`例如：${project.title} · 并发优化`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          className="button button-primary"
          onClick={() => {
            if (onSave(name)) setName("");
          }}
        >
          <Plus size={15} /> 保存快照
        </button>
      </div>
      {!project.scenarios.length ? (
        <div className="scenario-empty">
          <div className="empty-mark">A/B</div>
          <h3>还没有保存的方案</h3>
          <p>
            先在时序推演里调整并发或节点参数，再保存快照。之后可以在这里并排对比多份方案。
          </p>
        </div>
      ) : (
        <>
          <div className="matrix-toolbar">
            <span className="section-label">对比矩阵</span>
            <select
              className="matrix-sort-select"
              value={sort}
              aria-label="矩阵排序方式"
              onChange={(event) => setSort(event.target.value as MatrixSort)}
            >
              <option value="budget-asc">预算从低到高</option>
              <option value="budget-desc">预算从高到低</option>
              <option value="recent">最近保存优先</option>
            </select>
            <span className="matrix-count">
              已选 {pickedIds.length} / {MAX_MATRIX_COLUMNS} · 共{" "}
              {project.scenarios.length} 份
            </span>
          </div>
          <div className="matrix-chips">
            {project.scenarios.map((scenario) => {
              const active = pickedIds.includes(scenario.id);
              const invalid =
                assessmentById.get(scenario.id)?.status === "invalid";
              return (
                <button
                  key={scenario.id}
                  className={`matrix-chip${active ? " active" : ""}${invalid ? " chip-invalid" : ""}`}
                  disabled={!active && pickedIds.length >= MAX_MATRIX_COLUMNS}
                  title={
                    invalid
                      ? "该方案当前无法推演，不参与排序"
                      : active
                        ? "从矩阵移除"
                        : "加入矩阵"
                  }
                  onClick={() => togglePicked(scenario.id)}
                >
                  {scenario.name}
                </button>
              );
            })}
          </div>
          {!selectedColumns.length ? (
            <div className="matrix-empty">
              未选择参与矩阵的方案。在上方挑选 2–{MAX_MATRIX_COLUMNS}{" "}
              份方案并排对比。
            </div>
          ) : (
            <div className="matrix-scroll">
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th className="matrix-rowhead">对比项</th>
                    {selectedColumns.map((column) => (
                      <th key={column.scenario.id}>
                        <div className="matrix-col-head">
                          <strong>{column.scenario.name}</strong>
                          <small>{formatDate(column.scenario.createdAt)}</small>
                          {column.status === "stale" && (
                            <span className="status-badge status-stale">
                              已按当前模型重算
                            </span>
                          )}
                          {column.status === "invalid" && (
                            <span className="status-badge status-invalid">
                              无法推演
                            </span>
                          )}
                          <button
                            className="icon-button matrix-restore"
                            title="恢复此方案到当前链路"
                            aria-label={`恢复方案 ${column.scenario.name}`}
                            onClick={() =>
                              setPendingRestoreId(column.scenario.id)
                            }
                          >
                            <RotateCcw size={13} />
                          </button>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="matrix-rowhead">完成预算</td>
                    {selectedColumns.map((column) => (
                      <td
                        key={column.scenario.id}
                        className={
                          column.status === "invalid" ? "matrix-dim" : ""
                        }
                      >
                        {column.status === "invalid" ? (
                          <span className="matrix-invalid-value">无法推演</span>
                        ) : (
                          <>
                            <span className="matrix-budget">
                              {formatDuration(column.completionMs)}
                            </span>
                            {matrix.bestIds.has(column.scenario.id) && (
                              <em className="rank-badge rank-best">最好</em>
                            )}
                            {matrix.worstIds.has(column.scenario.id) && (
                              <em className="rank-badge rank-worst">最差</em>
                            )}
                            {column.status === "stale" && (
                              <small className="matrix-stale-note">
                                保存值{" "}
                                {formatDuration(column.storedCompletionMs)}
                              </small>
                            )}
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="matrix-rowhead">波动假设</td>
                    {selectedColumns.map((column) => (
                      <td
                        key={column.scenario.id}
                        className={
                          column.status === "invalid" ? "matrix-dim" : ""
                        }
                      >
                        {column.status === "invalid"
                          ? "—"
                          : MODE_LABELS[column.mode]}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="matrix-rowhead">并发策略</td>
                    {selectedColumns.map((column) => (
                      <td key={column.scenario.id}>
                        {concurrencyLabel(column.scenario.concurrencyLimit)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="matrix-rowhead">节点数</td>
                    {selectedColumns.map((column) => (
                      <td key={column.scenario.id}>
                        {column.scenario.nodes.length}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="matrix-rowhead">关键链路</td>
                    {selectedColumns.map((column) => (
                      <td
                        key={column.scenario.id}
                        className={
                          column.status === "invalid" ? "matrix-dim" : ""
                        }
                      >
                        {column.status === "invalid" ||
                        !column.criticalPath.length
                          ? "—"
                          : column.criticalPath
                              .map(
                                (id) =>
                                  column.scenario.nodes.find(
                                    (node) => node.id === id,
                                  )?.name ?? id,
                              )
                              .join(" → ")}
                      </td>
                    ))}
                  </tr>
                  {paramRows.length > 0 && (
                    <tr className="matrix-section-row">
                      <td colSpan={selectedColumns.length + 1}>
                        节点参数 · 耗时 / 波动 / 超时 / 重试（高亮 =
                        与行内首个方案不同，— = 该方案不含此节点）
                      </td>
                    </tr>
                  )}
                  {visibleParamRows.map((row) => (
                    <tr key={row.nodeId}>
                      <td className="matrix-rowhead" title={row.nodeName}>
                        {row.nodeName}
                      </td>
                      {row.cells.map((cell, index) => (
                        <td
                          key={selectedColumns[index]?.scenario.id ?? index}
                          className={`matrix-param-cell${
                            cell.present
                              ? cell.differs
                                ? " matrix-differs"
                                : ""
                              : " matrix-absent"
                          }`}
                        >
                          {cell.present ? (
                            <>
                              <b>{cell.durationMs} ms</b>
                              <small>
                                ±{cell.jitterMs} · 超时 {cell.timeoutMs} · 重试{" "}
                                {cell.retryCount}
                              </small>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {hiddenParamRows > 0 && (
                    <tr className="matrix-section-row">
                      <td colSpan={selectedColumns.length + 1}>
                        另有 {hiddenParamRows}{" "}
                        个节点未展开，可在下方详细差异中查看
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <div className="matrix-notes">
            {matrix.rankableCount === 0 && (
              <p className="matrix-note note-error">
                <TriangleAlert size={13} />{" "}
                没有可推演的方案，无法给出排序结论。请修复或删除无法推演的方案。
              </p>
            )}
            {matrix.excluded.length > 0 && (
              <p className="matrix-note note-error">
                <TriangleAlert size={13} /> {matrix.excluded.length}{" "}
                份方案当前无法推演，未参与排序与最好/最差标注：
                {matrix.excluded
                  .map(
                    (item) =>
                      `「${item.scenario.name}」${item.issues[0] ?? ""}`,
                  )
                  .join("；")}
              </p>
            )}
            {matrix.modesDiffer && matrix.rankableCount > 1 && (
              <p className="matrix-note note-warning">
                <TriangleAlert size={13} />{" "}
                各方案记录于不同的波动假设，完成预算的横向排序仅供对照。
              </p>
            )}
            {matrix.budgetsTied && (
              <p className="matrix-note note-warning">
                <TriangleAlert size={13} />{" "}
                可推演方案的完成预算持平，未标注最好与最差。
              </p>
            )}
          </div>
          {project.scenarios.length > 1 && baseline && comparison && (
            <div className="drilldown-section">
              <div className="snapshot-heading drilldown-heading">
                <span className="section-label">详细差异</span>
                <span>任选两份方案下钻</span>
              </div>
              <div className="compare-selectors">
                <div>
                  <span className="compare-label">基准方案</span>
                  <select
                    value={baseline.id}
                    onChange={(event) => onSelectBaseline(event.target.value)}
                  >
                    {project.scenarios.map((scenario) => (
                      <option key={scenario.id} value={scenario.id}>
                        {scenario.name}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="compare-vs">VS</span>
                <div>
                  <span className="compare-label">对照方案</span>
                  <select
                    value={comparison.id}
                    onChange={(event) => onSelectComparison(event.target.value)}
                  >
                    {project.scenarios.map((scenario) => (
                      <option key={scenario.id} value={scenario.id}>
                        {scenario.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="comparison-result">
                <article className="compare-card">
                  <span>基准完成时间</span>
                  <strong>
                    {baselineAssessment &&
                    baselineAssessment.status !== "invalid"
                      ? formatDuration(baselineAssessment.completionMs)
                      : "无法推演"}
                  </strong>
                  <small>
                    {baseline.name} · {baseline.nodes.length} 节点
                    {baselineAssessment?.status === "stale" ? " · 已重算" : ""}
                  </small>
                </article>
                <div className="delta-card">
                  <span>方案差异</span>
                  {bothRankable ? (
                    <>
                      <strong
                        className={delta > 0 ? "delta-bad" : "delta-good"}
                      >
                        {delta === 0 ? null : delta < 0 ? (
                          <ArrowDownRight size={17} />
                        ) : (
                          <ArrowUpRight size={17} />
                        )}
                        {formatDuration(Math.abs(delta))}
                      </strong>
                      <small>
                        {delta === 0
                          ? "两方案预算持平"
                          : delta < 0
                            ? "对照方案更快"
                            : "对照方案更慢"}
                      </small>
                    </>
                  ) : (
                    <>
                      <strong className="delta-unknown">—</strong>
                      <small>含无法推演的方案，不计算预算差异</small>
                    </>
                  )}
                </div>
                <article className="compare-card compare-card-accent">
                  <span>对照完成时间</span>
                  <strong>
                    {comparisonAssessment &&
                    comparisonAssessment.status !== "invalid"
                      ? formatDuration(comparisonAssessment.completionMs)
                      : "无法推演"}
                  </strong>
                  <small>
                    {comparison.name} · {comparison.nodes.length} 节点
                    {comparisonAssessment?.status === "stale"
                      ? " · 已重算"
                      : ""}
                  </small>
                </article>
              </div>
              {nodeSetSummary && (
                <div className="pair-summary">
                  <span>共同节点 {nodeSetSummary.shared}</span>
                  <span>仅基准 {nodeSetSummary.onlyBaseline.length}</span>
                  <span>仅对照 {nodeSetSummary.onlyComparison.length}</span>
                </div>
              )}
              {nodeSetSummary?.divergent && (
                <p className="matrix-note note-warning">
                  <TriangleAlert size={13} />{" "}
                  两份方案的共同节点不足一半，参数差异仅覆盖共同节点，预算差异主要来自链路结构变化。
                </p>
              )}
              <div className="change-summary">
                <strong>参数变化</strong>
                {changes.length ? (
                  changes.map((change) => <span key={change}>{change}</span>)
                ) : (
                  <span>两份方案的参数完全一致</span>
                )}
              </div>
            </div>
          )}
          <div className="snapshot-list">
            <div className="snapshot-heading">
              <span className="section-label">已保存快照</span>
              <span>{project.scenarios.length} 个方案</span>
            </div>
            {project.scenarios.map((scenario) => {
              const assessment = assessmentById.get(scenario.id);
              return (
                <div className="snapshot-row" key={scenario.id}>
                  <span className="snapshot-badge">S</span>
                  <div className="snapshot-info">
                    <strong>{scenario.name}</strong>
                    <small>
                      {formatDate(scenario.createdAt)} ·{" "}
                      {concurrencyLabel(scenario.concurrencyLimit)}
                      {assessment && assessment.status !== "invalid"
                        ? ` · ${MODE_LABELS[assessment.mode]}假设`
                        : ""}
                    </small>
                  </div>
                  {assessment?.status === "invalid" ? (
                    <b className="snapshot-time snapshot-invalid">无法推演</b>
                  ) : (
                    <b className="snapshot-time">
                      {formatDuration(
                        assessment?.completionMs ?? scenario.completionMs,
                      )}
                      {assessment?.status === "stale" && (
                        <small className="snapshot-stale">已重算</small>
                      )}
                    </b>
                  )}
                  <button
                    className="icon-button"
                    title="恢复此方案"
                    aria-label={`恢复方案 ${scenario.name}`}
                    onClick={() => setPendingRestoreId(scenario.id)}
                  >
                    <RotateCcw size={14} />
                  </button>
                  <button
                    className="icon-button danger-button"
                    title="删除方案"
                    aria-label={`删除方案 ${scenario.name}`}
                    onClick={() => onRemove(scenario.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
      {pendingScenario && pendingImpact && (
        <div
          className="restore-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`恢复方案 ${pendingScenario.name}`}
          onClick={(event) => {
            if (event.target === event.currentTarget) setPendingRestoreId(null);
          }}
        >
          <div className="restore-dialog">
            <h3>恢复「{pendingScenario.name}」到当前链路？</h3>
            <p>恢复后当前链路将被快照内容覆盖，已保存的其他方案不受影响。</p>
            <ul className="restore-impact-list">
              <li>
                <b>移除 {pendingImpact.removed.length} 个节点</b>
                {pendingImpact.removed.length
                  ? `：${joinNames(pendingImpact.removed)}`
                  : ""}
              </li>
              <li>
                <b>新增 {pendingImpact.added.length} 个节点</b>
                {pendingImpact.added.length
                  ? `：${joinNames(pendingImpact.added)}`
                  : ""}
              </li>
              <li>
                <b>覆盖 {pendingImpact.changed.length} 个节点的参数</b>
                {pendingImpact.changed.length
                  ? `：${joinNames(pendingImpact.changed)}`
                  : ""}
              </li>
              <li>
                <b>{pendingImpact.kept} 个节点保持不变</b>
              </li>
              <li>
                <b>并发策略</b>：
                {concurrencyLabel(pendingImpact.concurrencyFrom)} →{" "}
                {concurrencyLabel(pendingImpact.concurrencyTo)}
              </li>
            </ul>
            {pendingImpact.identical && (
              <p className="matrix-note note-info">
                当前链路与该方案完全一致，无需恢复。
              </p>
            )}
            {pendingAssessment?.status === "invalid" && (
              <p className="matrix-note note-error">
                <TriangleAlert size={13} /> 该方案当前无法推演（
                {pendingAssessment.issues[0] ?? "未知原因"}
                ），恢复后需先在请求编排中修复链路。
              </p>
            )}
            <div className="restore-actions">
              <button
                className="button button-ghost"
                onClick={() => setPendingRestoreId(null)}
              >
                取消
              </button>
              {canSaveCurrent && !pendingImpact.identical && (
                <button
                  className="button button-lime"
                  onClick={backupThenRestore}
                >
                  先备份当前再恢复
                </button>
              )}
              <button
                className="button button-primary"
                disabled={pendingImpact.identical}
                onClick={confirmRestore}
              >
                确认恢复
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
