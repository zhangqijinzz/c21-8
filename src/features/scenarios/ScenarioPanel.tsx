import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  ArrowUpDown,
  GitCompareArrows,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type {
  LatencyProject,
  ScenarioSnapshot,
} from "../../shared/domain/types";
import {
  buildScenarioMatrix,
  compareScenarios,
  describeRestoreImpact,
  type ScenarioMatrixRow,
} from "./scenarioViewModel";

interface Props {
  project: LatencyProject;
  onSave: (name: string) => boolean;
  onRemove: (id: string) => void;
  onRestore: (id: string) => void;
}

const DISPLAY_LIMIT = 8;

function formatDuration(value: number): string {
  return value < 1000
    ? `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(2)} s`;
}

function concurrencyLabel(limit: number | null): string {
  return limit ? `${limit} 路并发` : "不限并发";
}

function diffLabel(row: ScenarioMatrixRow): string {
  const parts: string[] = [];
  if (row.changedParamsVsCurrent)
    parts.push(`${row.changedParamsVsCurrent} 项参数`);
  if (row.addedNodesVsCurrent) parts.push(`+${row.addedNodesVsCurrent} 节点`);
  if (row.removedNodesVsCurrent)
    parts.push(`-${row.removedNodesVsCurrent} 节点`);
  return parts.length ? parts.join(" · ") : "与当前一致";
}

export default function ScenarioPanel({
  project,
  onSave,
  onRemove,
  onRestore,
}: Props) {
  const [name, setName] = useState("");
  const [sortAsc, setSortAsc] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [pair, setPair] = useState<string[]>([]);
  const [pendingRestore, setPendingRestore] = useState<ScenarioSnapshot | null>(
    null,
  );

  const matrix = useMemo(() => buildScenarioMatrix(project), [project]);
  const sortedRows = useMemo(() => {
    const rankable = matrix.rows
      .filter((row) => row.recheck.ok)
      .sort((a, b) =>
        sortAsc
          ? a.scenario.completionMs - b.scenario.completionMs
          : b.scenario.completionMs - a.scenario.completionMs,
      );
    const invalid = matrix.rows.filter((row) => !row.recheck.ok);
    return [...rankable, ...invalid];
  }, [matrix, sortAsc]);
  const visibleRows = expanded
    ? sortedRows
    : sortedRows.slice(0, DISPLAY_LIMIT);
  const hiddenCount = sortedRows.length - visibleRows.length;

  const drilldown = pair
    .map((id) => project.scenarios.find((scenario) => scenario.id === id))
    .filter((scenario): scenario is ScenarioSnapshot => Boolean(scenario));
  const drilldownComparison =
    drilldown.length === 2
      ? compareScenarios(drilldown[0]!, drilldown[1]!)
      : undefined;
  const drilldownHasInvalid = pair.some((id) => matrix.invalidIds.includes(id));
  const restoreImpact = pendingRestore
    ? describeRestoreImpact(project, pendingRestore.id)
    : undefined;

  const togglePair = (id: string) =>
    setPair((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id].slice(-2),
    );

  return (
    <section className="module-page scenarios-page">
      <div className="module-heading">
        <div>
          <span className="eyebrow">04 / SCENARIOS</span>
          <h1>方案对比</h1>
          <p>保存关键参数快照，判断一次调整是否真的缩短了等待。</p>
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
            先在时序推演里调整并发或节点参数，再保存快照。之后可以在这里查看完成时间差异。
          </p>
        </div>
      ) : (
        <>
          {matrix.cautions.map((caution) => (
            <div className="matrix-caution" key={caution}>
              <ShieldAlert size={14} />
              {caution}
            </div>
          ))}
          <div className="matrix-table">
            <div className="matrix-head">
              <span>下钻</span>
              <span>方案</span>
              <span>
                <button
                  className="matrix-sort"
                  onClick={() => setSortAsc((asc) => !asc)}
                  title="按完成预算排序"
                >
                  完成预算 <ArrowUpDown size={11} />
                  {sortAsc ? "升序" : "降序"}
                </button>
              </span>
              <span>并发策略</span>
              <span>与当前差异</span>
              <span>关键链路</span>
              <span>操作</span>
            </div>
            {visibleRows.map((row) => {
              const { scenario } = row;
              const selected = pair.includes(scenario.id);
              return (
                <div
                  className={`matrix-row ${row.recheck.ok ? "" : "is-invalid"} ${selected ? "is-selected" : ""}`}
                  key={scenario.id}
                >
                  <span>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => togglePair(scenario.id)}
                      title="勾选两个方案查看详细差异"
                      aria-label={`选择方案 ${scenario.name} 进行下钻对比`}
                    />
                  </span>
                  <span className="matrix-name">
                    <strong>{scenario.name}</strong>
                    <small>
                      {new Date(scenario.createdAt).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      · {scenario.nodes.length} 节点
                    </small>
                  </span>
                  <span className="matrix-budget">
                    <b>{formatDuration(scenario.completionMs)}</b>
                    {matrix.bestId === scenario.id && (
                      <em className="rank-badge rank-best">最优</em>
                    )}
                    {matrix.worstId === scenario.id && (
                      <em className="rank-badge rank-worst">最差</em>
                    )}
                    {!row.recheck.ok && (
                      <em
                        className="rank-badge rank-invalid"
                        title={row.recheck.errors.join("\n")}
                      >
                        无法复算 · 存档值
                      </em>
                    )}
                  </span>
                  <span>{concurrencyLabel(scenario.concurrencyLimit)}</span>
                  <span>{diffLabel(row)}</span>
                  <span
                    className="matrix-path"
                    title={row.criticalPathNames.join(" → ")}
                  >
                    {row.criticalPathNames.length
                      ? row.criticalPathNames.join(" → ")
                      : "—"}
                  </span>
                  <span className="matrix-actions">
                    <button
                      className="icon-button"
                      title="恢复此方案"
                      aria-label={`恢复方案 ${scenario.name}`}
                      onClick={() => setPendingRestore(scenario)}
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
                  </span>
                </div>
              );
            })}
            {hiddenCount > 0 && (
              <button
                className="matrix-expand"
                onClick={() => setExpanded(true)}
              >
                还有 {hiddenCount} 个方案未显示 · 展开全部 {sortedRows.length}{" "}
                个
              </button>
            )}
            {expanded && sortedRows.length > DISPLAY_LIMIT && (
              <button
                className="matrix-expand"
                onClick={() => setExpanded(false)}
              >
                收起列表
              </button>
            )}
          </div>
          <p className="matrix-hint">
            勾选任意两个方案可下钻查看详细差异；最优 / 最差基于全部{" "}
            {matrix.rankableIds.length} 份可复算方案。
          </p>
          {drilldown.length === 2 && drilldownComparison && (
            <div className="drilldown">
              <div className="snapshot-heading">
                <span className="section-label">详细差异</span>
                <span>
                  {drilldown[0]!.name} VS {drilldown[1]!.name}
                </span>
              </div>
              {drilldownHasInvalid && (
                <div className="matrix-caution">
                  <ShieldAlert size={14} />
                  其中一份方案当前无法复算，以下预算为存档值，差异结论仅供参考。
                </div>
              )}
              <div className="comparison-result">
                <article className="compare-card">
                  <span>基准完成时间</span>
                  <strong>{formatDuration(drilldown[0]!.completionMs)}</strong>
                  <small>
                    {drilldown[0]!.name} · {drilldown[0]!.nodes.length} 节点
                  </small>
                </article>
                <div className="delta-card">
                  <span>方案差异</span>
                  <strong
                    className={
                      drilldownComparison.outcome === "slower"
                        ? "delta-bad"
                        : "delta-good"
                    }
                  >
                    {drilldownComparison.outcome ===
                    "equal" ? null : drilldownComparison.outcome ===
                      "faster" ? (
                      <ArrowDownRight size={17} />
                    ) : (
                      <ArrowUpRight size={17} />
                    )}
                    {formatDuration(Math.abs(drilldownComparison.deltaMs))}
                  </strong>
                  <small>
                    {drilldownComparison.outcome === "equal"
                      ? "两方案预算持平"
                      : drilldownComparison.outcome === "faster"
                        ? "对照方案更快"
                        : "对照方案更慢"}
                  </small>
                </div>
                <article className="compare-card compare-card-accent">
                  <span>对照完成时间</span>
                  <strong>{formatDuration(drilldown[1]!.completionMs)}</strong>
                  <small>
                    {drilldown[1]!.name} · {drilldown[1]!.nodes.length} 节点
                  </small>
                </article>
              </div>
              {drilldownComparison.changes.length > 0 && (
                <div className="change-summary">
                  <strong>参数变化</strong>
                  {drilldownComparison.changes.map((change) => (
                    <span key={change}>{change}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {pendingRestore && restoreImpact && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="restore-scenario-title"
          >
            <span className="dialog-icon">
              <RotateCcw size={18} />
            </span>
            <h2 id="restore-scenario-title">
              恢复“{pendingRestore.name}”到当前链路？
            </h2>
            {restoreImpact.identical ? (
              <p>当前链路与该方案完全一致，恢复不会产生任何变化。</p>
            ) : (
              <>
                <p>恢复将覆盖当前链路的节点与并发设置：</p>
                <ul className="restore-impact">
                  {restoreImpact.removedNodeNames.length > 0 && (
                    <li>
                      移除 {restoreImpact.removedNodeNames.length} 个节点：
                      {restoreImpact.removedNodeNames.join("、")}
                    </li>
                  )}
                  {restoreImpact.addedNodeNames.length > 0 && (
                    <li>
                      新增 {restoreImpact.addedNodeNames.length} 个节点：
                      {restoreImpact.addedNodeNames.join("、")}
                    </li>
                  )}
                  {restoreImpact.changedParamCount > 0 && (
                    <li>覆盖 {restoreImpact.changedParamCount} 项节点参数</li>
                  )}
                  {restoreImpact.concurrencyFrom !==
                    restoreImpact.concurrencyTo && (
                    <li>
                      并发上限：
                      {concurrencyLabel(restoreImpact.concurrencyFrom)} →{" "}
                      {concurrencyLabel(restoreImpact.concurrencyTo)}
                    </li>
                  )}
                </ul>
                <p>
                  已保存的方案快照不受影响；当前链路未保存为方案的修改将丢失，可先在上方保存快照。
                </p>
              </>
            )}
            <div>
              <button
                className="button button-neutral"
                onClick={() => setPendingRestore(null)}
              >
                取消
              </button>
              <button
                className="button button-primary"
                disabled={restoreImpact.identical}
                onClick={() => {
                  onRestore(pendingRestore.id);
                  setPendingRestore(null);
                }}
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
