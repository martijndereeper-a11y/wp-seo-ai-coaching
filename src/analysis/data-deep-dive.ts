/**
 * Deep-dive data analysis on the ae_call_analysis table.
 * Run: npx tsx src/analysis/data-deep-dive.ts
 */

import { createSupabaseClient } from '../database/supabase-client.ts';

const supabase = createSupabaseClient();

const DIMS = [
  'contentEngine','marketContext','roiReframe','humor','urgency','contract',
  'checkIn','theirBusiness','activeListening','personalStory','vsAgency',
  'directness','opinionAsk','research','priceAnchor','assumptiveClose',
] as const;

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function dimVal(row: any, dim: string): number {
  return row.patterns?.[dim] ?? 0;
}

async function main() {
  // Fetch all rows
  const { data: rows, error } = await supabase
    .from('ae_call_analysis')
    .select('*');

  if (error) { console.error('Query error:', error); process.exit(1); }
  if (!rows || rows.length === 0) { console.log('No data found'); process.exit(0); }

  console.log(`Loaded ${rows.length} call analyses\n`);

  const won = rows.filter((r: any) => r.outcome === 'won');
  const lost = rows.filter((r: any) => r.outcome === 'lost');

  // ─── 1. BEHAVIOR-TO-WIN CORRELATION ──────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  1. BEHAVIOR-TO-WIN CORRELATION');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const dimResults: any[] = [];

  for (const dim of DIMS) {
    const avgWon = avg(won.map((r: any) => dimVal(r, dim)));
    const avgLost = avg(lost.map((r: any) => dimVal(r, dim)));
    const overallAvg = avg(rows.map((r: any) => dimVal(r, dim)));

    const above = rows.filter((r: any) => dimVal(r, dim) > overallAvg);
    const below = rows.filter((r: any) => dimVal(r, dim) <= overallAvg);

    const wrAbove = above.length ? above.filter((r: any) => r.outcome === 'won').length / above.length * 100 : 0;
    const wrBelow = below.length ? below.filter((r: any) => r.outcome === 'won').length / below.length * 100 : 0;
    const lift = wrAbove - wrBelow;

    dimResults.push({ dim, avgWon, avgLost, wrAbove, wrBelow, lift });
  }

  dimResults.sort((a, b) => b.lift - a.lift);

  console.log('Dimension            | Avg WON  | Avg LOST | WR Above | WR Below | Lift');
  console.log('─────────────────────┼──────────┼──────────┼──────────┼──────────┼──────');
  for (const d of dimResults) {
    console.log(
      `${d.dim.padEnd(21)}| ${d.avgWon.toFixed(2).padStart(8)} | ${d.avgLost.toFixed(2).padStart(8)} | ${d.wrAbove.toFixed(1).padStart(7)}% | ${d.wrBelow.toFixed(1).padStart(7)}% | ${(d.lift >= 0 ? '+' : '') + d.lift.toFixed(1)}%`,
    );
  }

  console.log('\nTop 5 strongest predictors of winning:');
  for (const d of dimResults.slice(0, 5)) {
    console.log(`  -> ${d.dim}: +${d.lift.toFixed(1)}pp lift when above average`);
  }

  // ─── 2. SCRIPT PHASE CORRELATION ────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  2. SCRIPT PHASE CORRELATION (Sections 1-12)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const sectionResults: any[] = [];

  for (let s = 1; s <= 12; s++) {
    const present = rows.filter((r: any) => r.sections_hit?.includes(s));
    const absent = rows.filter((r: any) => !r.sections_hit?.includes(s));

    const wrPresent = present.length ? present.filter((r: any) => r.outcome === 'won').length / present.length * 100 : 0;
    const wrAbsent = absent.length ? absent.filter((r: any) => r.outcome === 'won').length / absent.length * 100 : 0;
    const lift = wrPresent - wrAbsent;

    sectionResults.push({ section: s, present: present.length, absent: absent.length, wrPresent, wrAbsent, lift });
  }

  sectionResults.sort((a, b) => b.lift - a.lift);

  console.log('Section | Present | Absent | WR Present | WR Absent | Lift');
  console.log('────────┼─────────┼────────┼────────────┼───────────┼──────');
  for (const s of sectionResults) {
    console.log(
      `   ${String(s.section).padStart(2)}   |  ${String(s.present).padStart(5)}  | ${String(s.absent).padStart(5)}  |   ${s.wrPresent.toFixed(1).padStart(6)}%  |  ${s.wrAbsent.toFixed(1).padStart(6)}%  | ${(s.lift >= 0 ? '+' : '') + s.lift.toFixed(1)}%`,
    );
  }

  console.log('\nTop 3 most impactful script sections:');
  for (const s of sectionResults.slice(0, 3)) {
    console.log(`  -> Section ${s.section}: +${s.lift.toFixed(1)}pp lift when present`);
  }

  // ─── 3. TALK RATIO SWEET SPOT ──────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  3. TALK RATIO SWEET SPOT');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const trBuckets = [
    { label: '0-40%', min: 0, max: 40 },
    { label: '40-50%', min: 40, max: 50 },
    { label: '50-60%', min: 50, max: 60 },
    { label: '60-70%', min: 60, max: 70 },
    { label: '70%+', min: 70, max: 999 },
  ];

  console.log('Bucket   | Calls | Won | Lost | Win Rate');
  console.log('─────────┼───────┼─────┼──────┼──────────');
  for (const b of trBuckets) {
    const inBucket = rows.filter((r: any) => r.talk_ratio >= b.min && r.talk_ratio < b.max);
    const wonCount = inBucket.filter((r: any) => r.outcome === 'won').length;
    const lostCount = inBucket.filter((r: any) => r.outcome === 'lost').length;
    const wr = inBucket.length ? wonCount / inBucket.length * 100 : 0;
    console.log(`${b.label.padEnd(9)}| ${String(inBucket.length).padStart(5)} | ${String(wonCount).padStart(3)} | ${String(lostCount).padStart(4)} | ${wr.toFixed(1)}%`);
  }

  // ─── 4. QUESTION COUNT SWEET SPOT ──────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  4. QUESTION COUNT SWEET SPOT');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const qBuckets = [
    { label: '0-10', min: 0, max: 10 },
    { label: '10-20', min: 10, max: 20 },
    { label: '20-30', min: 20, max: 30 },
    { label: '30-40', min: 30, max: 40 },
    { label: '40+', min: 40, max: 99999 },
  ];

  console.log('Bucket | Calls | Won | Lost | Win Rate');
  console.log('───────┼───────┼─────┼──────┼──────────');
  for (const b of qBuckets) {
    const inBucket = rows.filter((r: any) => r.question_count >= b.min && r.question_count < b.max);
    const wonCount = inBucket.filter((r: any) => r.outcome === 'won').length;
    const lostCount = inBucket.filter((r: any) => r.outcome === 'lost').length;
    const wr = inBucket.length ? wonCount / inBucket.length * 100 : 0;
    console.log(`${b.label.padEnd(7)}| ${String(inBucket.length).padStart(5)} | ${String(wonCount).padStart(3)} | ${String(lostCount).padStart(4)} | ${wr.toFixed(1)}%`);
  }

  // ─── 5. CALL DURATION SWEET SPOT ───────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  5. CALL DURATION SWEET SPOT');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const dBuckets = [
    { label: '0-15min', min: 0, max: 900 },
    { label: '15-30min', min: 900, max: 1800 },
    { label: '30-45min', min: 1800, max: 2700 },
    { label: '45-60min', min: 2700, max: 3600 },
    { label: '60+min', min: 3600, max: 999999 },
  ];

  console.log('Bucket   | Calls | Won | Lost | Win Rate');
  console.log('─────────┼───────┼─────┼──────┼──────────');
  for (const b of dBuckets) {
    const inBucket = rows.filter((r: any) => (r.duration_seconds || 0) >= b.min && (r.duration_seconds || 0) < b.max);
    const wonCount = inBucket.filter((r: any) => r.outcome === 'won').length;
    const lostCount = inBucket.filter((r: any) => r.outcome === 'lost').length;
    const wr = inBucket.length ? wonCount / inBucket.length * 100 : 0;
    console.log(`${b.label.padEnd(9)}| ${String(inBucket.length).padStart(5)} | ${String(wonCount).padStart(3)} | ${String(lostCount).padStart(4)} | ${wr.toFixed(1)}%`);
  }

  // ─── 6. STREAK ANALYSIS ────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  6. STREAK ANALYSIS (per AE)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const byAE = new Map<string, any[]>();
  for (const r of rows) {
    if (!byAE.has(r.recorder_name)) byAE.set(r.recorder_name, []);
    byAE.get(r.recorder_name)!.push(r);
  }

  console.log('AE Name                     | Current Streak     | Longest Win | Longest Loss');
  console.log('────────────────────────────┼────────────────────┼─────────────┼─────────────');

  for (const [name, calls] of byAE) {
    const sorted = [...calls].sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    // Current streak (from most recent)
    let currentStreak = 0;
    const currentType = sorted[sorted.length - 1]?.outcome;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].outcome === currentType) currentStreak++;
      else break;
    }

    // Longest win/loss streaks
    let longestWin = 0, longestLoss = 0, tempStreak = 0, tempType: string | null = null;
    for (const c of sorted) {
      if (c.outcome === tempType) {
        tempStreak++;
      } else {
        tempType = c.outcome;
        tempStreak = 1;
      }
      if (tempType === 'won' && tempStreak > longestWin) longestWin = tempStreak;
      if (tempType === 'lost' && tempStreak > longestLoss) longestLoss = tempStreak;
    }

    const streakLabel = `${currentStreak} ${currentType === 'won' ? 'W' : 'L'}`;
    console.log(
      `${name.padEnd(28)}| ${streakLabel.padEnd(19)}| ${String(longestWin).padStart(11)} | ${String(longestLoss).padStart(11)}`,
    );
  }

  // ─── 7. TOP PERFORMER MOMENTS ──────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  7. TOP PERFORMER MOMENTS (AEs with >55% win rate)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  for (const [name, calls] of byAE) {
    if (calls.length < 3) continue;
    const winRate = calls.filter((c: any) => c.outcome === 'won').length / calls.length * 100;
    if (winRate <= 55) continue;

    console.log(`\n>> ${name} (${winRate.toFixed(0)}% win rate, ${calls.length} calls)`);
    console.log('  ────────────────────────────────────────────');

    // Collect all strength highlights across calls
    const strengths: any[] = [];
    for (const c of calls) {
      if (!c.highlights || !Array.isArray(c.highlights)) continue;
      for (const h of c.highlights) {
        if (h.type === 'strength') {
          strengths.push({
            recording_url: c.recording_url,
            timestamp: h.timestamp || 'N/A',
            category: h.category || h.dimension || 'general',
            excerpt: h.excerpt || h.text || h.description || 'N/A',
          });
        }
      }
    }

    if (strengths.length === 0) {
      console.log('  (No strength highlights found)');
      continue;
    }

    // Show top 3
    for (const s of strengths.slice(0, 3)) {
      console.log(`  Category:  ${s.category}`);
      console.log(`  Excerpt:   ${(s.excerpt || '').substring(0, 120)}`);
      console.log(`  Recording: ${s.recording_url || 'N/A'}`);
      console.log(`  Timestamp: ${s.timestamp}`);
      console.log('');
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  ANALYSIS COMPLETE');
  console.log(`  Total calls analyzed: ${rows.length} (${won.length} won, ${lost.length} lost)`);
  console.log(`  Overall win rate: ${(won.length / rows.length * 100).toFixed(1)}%`);
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
