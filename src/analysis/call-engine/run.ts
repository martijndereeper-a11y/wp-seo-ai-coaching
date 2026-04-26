/**
 * Call Engine orchestrator — runs extraction-free analysis over Supabase data
 * and writes the 5 reports.
 *
 * Usage:
 *   npx tsx src/analysis/call-engine/run.ts
 */

import { loadFeatureMatrix } from './features.ts';
import { runCausalAnalysis, runQualityAssociations } from './causal.ts';
import { profileAes } from './profiler.ts';
import { writeScriptReport, writeMarketReport, writeAeCoachingReport, writeDeviationReport, writeExecutiveSummary } from './reports.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = join(process.cwd(), 'work', 'call-engine-output');
mkdirSync(outDir, { recursive: true });

console.log('Loading feature matrix from Supabase…');
const fm = await loadFeatureMatrix({ firstMeetingsOnly: true });
console.log(`  → ${fm.rows.length} won/lost first-meeting calls, ${fm.behaviorIds.length} behaviors, ${fm.pillarIds.length} pillars`);
console.log(`  → ${new Set(fm.rows.map(r => r.aeId)).size} AEs, markets: ${Array.from(new Set(fm.rows.map(r => r.market))).join(', ')}`);

console.log('\nRunning within-AE causal analysis…');
const estimates = runCausalAnalysis(fm);
console.log(`  → ${estimates.length} estimates (${estimates.filter(e => e.classification === 'winning').length} winning · ${estimates.filter(e => e.classification === 'harmful').length} harmful)`);

console.log('\nRunning call-quality associations…');
const quality = runQualityAssociations(fm);
console.log(`  → ${quality.length} behaviors with ≥30 with/without samples`);

console.log('\nProfiling AEs (residual rank)…');
const profiling = profileAes(fm);
console.log(`  → ${profiling.profiles.length} AEs profiled · ${profiling.topAeIds.size} top performers`);

console.log('\nWriting reports…');
const p1 = writeScriptReport(outDir, fm, estimates);
const p2 = writeMarketReport(outDir, fm, estimates);
const p3 = writeAeCoachingReport(outDir, fm, profiling, estimates);
const p4 = writeDeviationReport(outDir, fm, estimates, profiling);
const p5 = writeExecutiveSummary(outDir, fm, estimates, profiling, quality);

// Dump raw JSON for downstream ingestion
const raw = { estimates, profiling, quality, meta: { totalCalls: fm.rows.length, won: fm.rows.filter(r => r.outcome === 1).length, aes: new Set(fm.rows.map(r => r.aeId)).size } };
writeFileSync(join(outDir, 'analysis.json'), JSON.stringify(raw, null, 2));

console.log('');
for (const p of [p1, p2, p3, p4, p5]) console.log(`  ${p}`);
console.log(`  ${join(outDir, 'analysis.json')}`);
console.log('\nDone.');
