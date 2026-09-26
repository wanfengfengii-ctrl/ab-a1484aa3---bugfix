import type {
  AdjudicationOutcome,
  Limits,
  Plan,
  Scenario,
  StepRecord,
  Violation,
  ViolationKind,
} from './types';

/**
 * 数值比较容差：质量/力臂为浮点录入，载荷与力矩的边界判定及力矩余量决胜使用。
 * 注意：安装代价不使用此容差——代价是逐位有意义的录入值，必须严格比较。
 */
export const EPS = 1e-9;

interface FlatOption {
  optionIndex: number;
  railId: string;
  railName: string;
  coordinate: number;
  cost: number;
}

interface FlatBlock {
  index: number;
  name: string;
  mass: number;
  options: FlatOption[];
}

/**
 * 升序累加非负代价。安装代价是录入值而非物理测量值，必须逐位严格比较，
 * 不得套用 EPS（否则 1e-10 这样的纳米级代价差会被误判为并列）。
 * 按固定升序累加使总和与挂装次序无关：同一组代价无论以何种次序挂装，
 * 得到的总代价逐位相同，真正同代价的方案才能稳定地落到序号决胜。
 */
function sumCostsAscending(sortedAscending: readonly number[]): number {
  let total = 0;
  for (const c of sortedAscending) total += c;
  return total;
}

function torqueMarginOf(torque: number, limits: Limits): number {
  return Math.min(torque - limits.minTorque, limits.maxTorque - torque);
}

/** 按 (块录入序号, 位置录入序号) 沿挂装次序逐位比较，保证稳定决胜。 */
function lexCompareSteps(a: StepRecord[], b: StepRecord[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].blockIndex !== b[i].blockIndex) return a[i].blockIndex - b[i].blockIndex;
    if (a[i].optionIndex !== b[i].optionIndex) return a[i].optionIndex - b[i].optionIndex;
  }
  return a.length - b.length;
}

/**
 * 裁决优先级（依次）：
 * 1. 力矩余量（所有前缀中的最小值）最大者优先；
 * 2. 总安装代价最小者优先（严格数值比较，不使用容差：代价是录入值，
 *    任何实际差异——哪怕仅 1e-10——都必须体现，序号决胜不得覆盖成本差）；
 * 3. 按挂装顺序的 (块录入序号, 位置录入序号) 序列字典序最小者优先。
 */
function isBetter(a: Plan, b: Plan | null): boolean {
  if (b === null) return true;
  if (a.minTorqueMargin > b.minTorqueMargin + EPS) return true;
  if (a.minTorqueMargin < b.minTorqueMargin - EPS) return false;
  if (a.totalCost < b.totalCost) return true;
  if (a.totalCost > b.totalCost) return false;
  return lexCompareSteps(a.steps, b.steps) < 0;
}

/**
 * 裁决：联合确定每块配重恰用一次的挂入位置与完整挂装次序。
 *
 * 搜索按挂装顺序逐步进行，每一个前缀状态都同时校验总载荷与力矩闭区间，
 * 因此绝不出现“先定最终位置再事后排序”的情况；力矩余量沿前缀单调不增、
 * 总代价单调不减（代价非负），据此对当前最优解做分支限界。
 */
export function adjudicate(scenario: Scenario): AdjudicationOutcome {
  const railById = new Map(scenario.rails.map((r) => [r.id, r]));
  const blocks: FlatBlock[] = scenario.blocks.map((b, i) => ({
    index: i,
    name: b.name,
    mass: b.mass,
    options: b.options.map((o, j) => {
      const rail = railById.get(o.railId);
      if (!rail) throw new Error(`未知导轨位置: ${o.railId}`);
      return {
        optionIndex: j,
        railId: rail.id,
        railName: rail.name,
        coordinate: rail.coordinate,
        cost: o.cost,
      };
    }),
  }));
  const n = blocks.length;
  const limits = scenario.limits;

  const used = new Array<boolean>(n).fill(false);
  const steps: StepRecord[] = [];
  /** 当前路径已选代价，始终保持升序，使总代价与挂装次序无关。 */
  const pathCosts: number[] = [];
  let best: Plan | null = null;
  /** 每个深度上按裁决优先级最优的可行前缀（用于无可行方案时的诊断）。 */
  const bestPartial: (Plan | null)[] = new Array(n + 1).fill(null);

  const snapshot = (totalCost: number, minTorqueMargin: number): Plan => ({
    steps: steps.map((s) => ({ ...s })),
    totalCost,
    minTorqueMargin,
    finalMass: steps.length > 0 ? steps[steps.length - 1].cumulativeMass : 0,
    finalTorque: steps.length > 0 ? steps[steps.length - 1].cumulativeTorque : 0,
  });

  const dfs = (depth: number, mass: number, torque: number, totalCost: number, minMargin: number): void => {
    const current = snapshot(totalCost, minMargin);
    if (isBetter(current, bestPartial[depth])) bestPartial[depth] = current;
    if (depth === n) {
      if (isBetter(current, best)) best = current;
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const block = blocks[i];
      for (const opt of block.options) {
        const massAfter = mass + block.mass;
        if (massAfter > limits.maxLoad + EPS) continue;
        const torqueAfter = torque + block.mass * opt.coordinate;
        if (torqueAfter < limits.minTorque - EPS || torqueAfter > limits.maxTorque + EPS) continue;
        const margin = torqueMarginOf(torqueAfter, limits);
        const nextMinMargin = Math.min(minMargin, margin);
        // 将本步代价按升序插路径后重算规范总代价（代价非负，规模 ≤7，开销可忽略）。
        let lo = 0;
        let hi = pathCosts.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (pathCosts[mid] <= opt.cost) lo = mid + 1;
          else hi = mid;
        }
        pathCosts.splice(lo, 0, opt.cost);
        const nextCost = sumCostsAscending(pathCosts);
        if (best) {
          // 力矩余量已严格劣于最优解，剪枝。
          if (nextMinMargin < best.minTorqueMargin - EPS) {
            pathCosts.splice(lo, 1);
            continue;
          }
          // 余量无法严格更优，而代价（非负，继续挂装只会更高）已严格更贵，剪枝。
          // 严格数值比较：哪怕只差 1e-10 也必须保留更便宜的分支。
          if (nextMinMargin < best.minTorqueMargin + EPS && nextCost > best.totalCost) {
            pathCosts.splice(lo, 1);
            continue;
          }
        }
        used[i] = true;
        steps.push({
          blockIndex: i,
          blockName: block.name,
          optionIndex: opt.optionIndex,
          railId: opt.railId,
          railName: opt.railName,
          coordinate: opt.coordinate,
          mass: block.mass,
          cost: opt.cost,
          cumulativeMass: massAfter,
          cumulativeTorque: torqueAfter,
          loadMargin: limits.maxLoad - massAfter,
          torqueMargin: margin,
        });
        dfs(depth + 1, massAfter, torqueAfter, nextCost, nextMinMargin);
        steps.pop();
        used[i] = false;
        pathCosts.splice(lo, 1);
      }
    }
  };

  dfs(0, 0, 0, 0, Number.POSITIVE_INFINITY);

  if (best) return { feasible: true, plan: best };

  // 无可行方案：定位最深的可行已选前缀（其下一步即最早无法继续挂装的位置）。
  let depth = n - 1;
  while (depth >= 0 && bestPartial[depth] === null) depth--;
  const witness = depth >= 0 ? bestPartial[depth] : null;
  const witnessSteps = witness ? witness.steps : [];
  const usedBlocks = new Set(witnessSteps.map((s) => s.blockIndex));
  const baseMass = witness ? witness.finalMass : 0;
  const baseTorque = witness ? witness.finalTorque : 0;

  const violations: Violation[] = [];
  for (const block of blocks) {
    if (usedBlocks.has(block.index)) continue;
    for (const opt of block.options) {
      const massAfter = baseMass + block.mass;
      const torqueAfter = baseTorque + block.mass * opt.coordinate;
      const kinds: ViolationKind[] = [];
      if (massAfter > limits.maxLoad + EPS) kinds.push('load');
      if (torqueAfter < limits.minTorque - EPS) kinds.push('torque-low');
      if (torqueAfter > limits.maxTorque + EPS) kinds.push('torque-high');
      if (kinds.length > 0) {
        violations.push({
          blockIndex: block.index,
          blockName: block.name,
          optionIndex: opt.optionIndex,
          railId: opt.railId,
          railName: opt.railName,
          massAfter,
          torqueAfter,
          kinds,
        });
      }
    }
  }
  return { feasible: false, report: { witnessPrefix: witnessSteps, violations } };
}
