import { Hono } from 'hono';
import { supabase, fetchParsedTranscript } from '../shared.ts';
import { scoreGame } from '../../analysis/sales-game.ts';

const routes = new Hono();

// Game leaderboard
routes.get('/game/leaderboard', async (c) => {
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('recorder_name, game_score, outcome, created_at')
    .not('game_score', 'is', null)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);

  const byAE = new Map<string, any[]>();
  for (const row of (data || [])) {
    if (!row.game_score || !row.game_score.totalPoints === undefined) continue;
    const name = row.recorder_name;
    if (!byAE.has(name)) byAE.set(name, []);
    byAE.get(name)!.push(row);
  }

  const leaderboard = Array.from(byAE.entries()).map(([name, calls]) => {
    const scores = calls.map(c => c.game_score.totalPoints || 0);
    const avgScore = Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length);
    const touchdowns = calls.filter(c => c.game_score.actions?.find((a: any) => a.id === 'F' && a.earned)).length;
    const perfectGames = calls.filter(c => c.game_score.totalPoints === 70).length;

    const actionHits: Record<string, number> = {};
    for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const earned = calls.filter(c => c.game_score.actions?.find((a: any) => a.id === id && a.earned)).length;
      actionHits[id] = Math.round((earned / calls.length) * 100);
    }

    return { name, totalCalls: calls.length, avgScore, touchdowns, perfectGames, actionHitRates: actionHits, recentScores: scores.slice(0, 5) };
  });

  leaderboard.sort((a, b) => b.avgScore - a.avgScore);
  return c.json({ leaderboard });
});

// AE game history
routes.get('/game/ae/:name', async (c) => {
  const name = c.req.param('name');
  const { data } = await supabase
    .from('ae_call_analysis')
    .select('recording_id, title, deal_name, outcome, created_at, game_score')
    .eq('recorder_name', name)
    .not('game_score', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50);

  return c.json({
    ae: name,
    calls: (data || []).map(d => ({
      recordingId: d.recording_id, title: d.title, deal: d.deal_name,
      outcome: d.outcome, date: d.created_at, gameScore: d.game_score,
    })),
  });
});

// Live game score
routes.get('/call/:id/game-score', async (c) => {
  const id = c.req.param('id');
  const { data: analysis } = await supabase
    .from('ae_call_analysis')
    .select('game_score, outcome')
    .eq('recording_id', id)
    .single();

  if (analysis?.game_score?.totalPoints !== undefined) return c.json(analysis.game_score);

  const recording = await fetchParsedTranscript(id);
  if (!recording) return c.json({ error: 'No transcript' }, 404);

  const outcome = analysis?.outcome || 'unknown';
  const score = scoreGame(recording.turns, recording.recorderName, outcome);
  return c.json(score);
});

export default routes;
