/**
 * Minimal stats utilities for call-engine analysis.
 * Ports bootstrap_ci + within-AE FWL demeaning from the Python engine.
 */

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

/**
 * OLS slope of y on t (no intercept). Equivalent to y = beta*t when data are centered.
 * Returns beta + residual standard error for t-test.
 */
export function olsNoIntercept(t: number[], y: number[]): { beta: number; tStat: number; dof: number } {
  let num = 0, den = 0;
  for (let i = 0; i < t.length; i++) {
    num += t[i] * y[i];
    den += t[i] * t[i];
  }
  if (den === 0) return { beta: 0, tStat: 0, dof: 0 };
  const beta = num / den;
  let sse = 0;
  for (let i = 0; i < t.length; i++) {
    const r = y[i] - beta * t[i];
    sse += r * r;
  }
  const dof = t.length - 1;
  if (dof <= 0) return { beta, tStat: 0, dof };
  const mse = sse / dof;
  const se = Math.sqrt(mse / den);
  const tStat = se > 0 ? beta / se : 0;
  return { beta, tStat, dof };
}

/**
 * Approximate two-sided p-value for t-statistic using normal approx (dof large enough).
 * Good enough for dof > 30.
 */
export function twoSidedPFromT(tStat: number, _dof: number): number {
  const abs = Math.abs(tStat);
  // Normal approximation (valid for dof > 30; our samples are much larger)
  return 2 * (1 - normalCdf(abs));
}

function normalCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804 * Math.exp(-z * z / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - p;
}

/**
 * Bootstrap CI via percentile method.
 * stat: function on a resampled (parallel) array of rows.
 */
export function bootstrapCi<T>(rows: T[], stat: (sample: T[]) => number, n = 1000, ci = 0.95): [number, number] {
  if (rows.length === 0) return [NaN, NaN];
  const stats: number[] = [];
  for (let i = 0; i < n; i++) {
    const sample: T[] = [];
    for (let j = 0; j < rows.length; j++) sample.push(rows[Math.floor(Math.random() * rows.length)]);
    const v = stat(sample);
    if (Number.isFinite(v)) stats.push(v);
  }
  if (stats.length < n * 0.5) return [NaN, NaN];
  stats.sort((a, b) => a - b);
  const alpha = 1 - ci;
  return [quantile(stats, alpha / 2), quantile(stats, 1 - alpha / 2)];
}

/**
 * Within-AE FWL (Frisch-Waugh-Lovell):
 *   - Keep AEs with n>=minCalls and treatment_mean in [minVar, 1-minVar]
 *   - Demean Y and T by AE mean
 *   - OLS (no intercept) on demeaned data
 *   - Bootstrap CI on demeaned pairs
 * Returns null if insufficient data.
 */
export type WithinAeInput = { aeId: string; t: number; y: number };
export type WithinAeResult = {
  beta: number;
  ciLower: number;
  ciUpper: number;
  pValue: number | null;
  nTreated: number;
  nControl: number;
  nAes: number;
  baseRate: number;
  treatedRate: number;
};

export function withinAe(rows: WithinAeInput[], minCalls = 10, minVar = 0.15): WithinAeResult | null {
  const byAe = new Map<string, WithinAeInput[]>();
  for (const r of rows) {
    const list = byAe.get(r.aeId) ?? [];
    list.push(r);
    byAe.set(r.aeId, list);
  }

  const valid: WithinAeInput[] = [];
  for (const [aeId, list] of byAe) {
    if (list.length < minCalls) continue;
    const tMean = mean(list.map(r => r.t));
    if (tMean < minVar || tMean > 1 - minVar) continue;
    for (const r of list) valid.push(r);
  }

  if (valid.length < 30) return null;
  const nAes = new Set(valid.map(r => r.aeId)).size;
  if (nAes < 2) return null;

  // Demean by AE
  const aeMeans = new Map<string, { tm: number; ym: number }>();
  for (const [aeId, list] of byAe) {
    if (list.length < minCalls) continue;
    const tm = mean(list.map(r => r.t));
    if (tm < minVar || tm > 1 - minVar) continue;
    aeMeans.set(aeId, { tm, ym: mean(list.map(r => r.y)) });
  }

  const tDem: number[] = [];
  const yDem: number[] = [];
  for (const r of valid) {
    const m = aeMeans.get(r.aeId)!;
    tDem.push(r.t - m.tm);
    yDem.push(r.y - m.ym);
  }

  const { beta, tStat } = olsNoIntercept(tDem, yDem);
  const dofEff = valid.length - nAes - 1;
  const pValue = dofEff > 0 ? twoSidedPFromT(tStat, dofEff) : null;

  const pairs = tDem.map((t, i) => ({ t, y: yDem[i] }));
  const [ciLower, ciUpper] = bootstrapCi(pairs, (sample) => {
    let num = 0, den = 0;
    for (const p of sample) { num += p.t * p.y; den += p.t * p.t; }
    return den > 0 ? num / den : 0;
  }, 500);

  const treated = valid.filter(r => r.t >= 0.5);
  const control = valid.filter(r => r.t < 0.5);
  const baseRate = control.length ? mean(control.map(r => r.y)) : 0;
  const treatedRate = treated.length ? mean(treated.map(r => r.y)) : 0;

  return {
    beta: round4(beta),
    ciLower: round4(ciLower),
    ciUpper: round4(ciUpper),
    pValue: pValue !== null ? round4(pValue) : null,
    nTreated: treated.length,
    nControl: control.length,
    nAes,
    baseRate: round4(baseRate),
    treatedRate: round4(treatedRate),
  };
}

/**
 * Multivariate OLS via normal equations. Returns coefficient vector including intercept.
 * X: n×k design matrix (rows, not including intercept column — we add it).
 * Handles small k well; fine for ~30 market/industry dummies.
 */
export function olsWithIntercept(X: number[][], y: number[]): number[] {
  const n = X.length;
  if (n === 0) return [];
  const k = X[0].length + 1;

  // Build X with intercept column
  const Xi: number[][] = X.map(row => [1, ...row]);

  // Compute X'X (k×k) and X'y (k)
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += Xi[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += Xi[i][a] * Xi[i][b];
    }
  }

  // Solve via Gauss-Jordan with ridge fallback if singular
  const ridge = 1e-8;
  for (let i = 0; i < k; i++) XtX[i][i] += ridge;

  return solveLinear(XtX, Xty);
}

function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let i = 0; i < n; i++) {
    // Pivot
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    if (piv !== i) [M[i], M[piv]] = [M[piv], M[i]];
    const d = M[i][i];
    if (Math.abs(d) < 1e-12) continue; // skip
    for (let j = i; j <= n; j++) M[i][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i];
      for (let j = i; j <= n; j++) M[r][j] -= f * M[i][j];
    }
  }

  return M.map(row => row[n]);
}

export function round4(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.round(x * 10000) / 10000;
}

export function fmtPct(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';
  const sign = x > 0 ? '+' : '';
  return `${sign}${(x * 100).toFixed(1)}%`;
}
