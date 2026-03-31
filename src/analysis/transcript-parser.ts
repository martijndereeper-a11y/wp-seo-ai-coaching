/**
 * Transcript Parser
 *
 * Parses Claap transcript text format ("12:15 Speaker Name: text...")
 * into structured segments with speaker, timestamp, and metrics.
 */

export interface TranscriptTurn {
  timestampSeconds: number;
  timestampDisplay: string;
  speaker: string;
  text: string;
  wordCount: number;
  isQuestion: boolean;
}

export interface SpeakerStats {
  name: string;
  turnCount: number;
  wordCount: number;
  questionCount: number;
  talkRatio: number;
  longestMonologue: number; // consecutive words without other speaker
  avgTurnLength: number;
}

export interface ParsedTranscript {
  turns: TranscriptTurn[];
  speakers: Map<string, SpeakerStats>;
  totalTurns: number;
  totalWords: number;
  durationSeconds: number;
}

const TIMESTAMP_LINE = /^(\d{1,2}):(\d{2})\s+(.+?):\s+(.+)$/;

/**
 * Detect if a turn contains a REAL question — not rhetorical, not filler, not self-directed.
 * Only counts questions that are genuinely directed at the other person to gather information.
 */
function isRealQuestion(text: string): boolean {
  if (!text.includes('?')) return false;

  const t = text.toLowerCase();

  // 1. Strip rhetorical/filler tags (Dutch + German)
  const stripped = t
    .replace(/\btoch\?|\bof niet\?|\bhè\?|\bja\?|\bnee\?|\bsnap je\?|\bweet je\?|\bniet waar\?/gi, '')
    .replace(/\boder\?|\bne\?|\bgell\?|\bricht?ig\?|\bnich[t]?\?|\bokay\?|\boké\?|\boke\?/gi, '')
    .replace(/\boder nicht\?|\bnicht wahr\?|\bverstehst du\?|\bweißt du\?|\bkennst du\?/gi, '');
  if (!stripped.includes('?')) return false;

  // 2. Skip greetings and audio checks
  if (/^(hallo|hi|hey|guten|goede|moin).{0,40}\?$/i.test(t.trim())) return false;
  if (/horen\?$|hören\?$|zien\?$|sehen\?$|verstaan\?$/i.test(t.trim())) return false;

  // 3. Skip very short "questions" (< 5 words before ?)
  const beforeQ = t.split('?')[0].trim();
  const wordsBeforeQ = beforeQ.split(/\s+/).filter(w => w.length > 1).length;
  if (wordsBeforeQ < 4) return false;

  // 4. Skip self-directed questions (AE talking to themselves)
  if (/\bwas sollen wir\b|\bwie soll ich\b|\bwie sage ich\b|\bsoll ich\b|\bfangen wir\b|\bmachen wir\b|\bschauen wir\b|\bgehen wir\b/i.test(t)) return false;
  if (/\bwat zullen we\b|\bhoe zal ik\b|\bzullen we\b|\blaten we\b|\bgaan we\b|\bpakken we\b/i.test(t)) return false;

  // 5. Skip presentation setup questions (AE framing their own pitch)
  if (/\bwie machen wir\b|\bund wie\?\s*ganz einfach\b|\bwas bedeutet das\?\s*(ganz|das|nun)/i.test(t)) return false;
  if (/\bhoe doen wij dat\b|\ben hoe\?\s*(heel|dat|nou)/i.test(t)) return false;

  return true;
}

export function parseTranscript(text: string, aeName?: string): ParsedTranscript {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const turns: TranscriptTurn[] = [];
  const speakerWords = new Map<string, number>();
  const speakerTurns = new Map<string, number>();
  const speakerQuestions = new Map<string, number>();
  const speakerLongestMono = new Map<string, number>();

  for (const line of lines) {
    const match = line.trim().match(TIMESTAMP_LINE);
    if (!match) continue;

    const [, minStr, secStr, speaker, text] = match;
    const mins = parseInt(minStr, 10);
    const secs = parseInt(secStr, 10);
    const timestampSeconds = mins * 60 + secs;
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
    // Count real questions — exclude rhetorical tags, filler questions, audio checks
    const isQuestion = isRealQuestion(text);

    turns.push({
      timestampSeconds,
      timestampDisplay: `${minStr}:${secStr}`,
      speaker,
      text,
      wordCount,
      isQuestion,
    });

    speakerWords.set(speaker, (speakerWords.get(speaker) || 0) + wordCount);
    speakerTurns.set(speaker, (speakerTurns.get(speaker) || 0) + 1);
    if (isQuestion) {
      speakerQuestions.set(speaker, (speakerQuestions.get(speaker) || 0) + 1);
    }
  }

  // Calculate longest monologues (consecutive turns by same speaker)
  let currentSpeaker = '';
  let currentMonoWords = 0;
  for (const turn of turns) {
    if (turn.speaker === currentSpeaker) {
      currentMonoWords += turn.wordCount;
    } else {
      if (currentSpeaker) {
        const prev = speakerLongestMono.get(currentSpeaker) || 0;
        speakerLongestMono.set(currentSpeaker, Math.max(prev, currentMonoWords));
      }
      currentSpeaker = turn.speaker;
      currentMonoWords = turn.wordCount;
    }
  }
  if (currentSpeaker) {
    const prev = speakerLongestMono.get(currentSpeaker) || 0;
    speakerLongestMono.set(currentSpeaker, Math.max(prev, currentMonoWords));
  }

  const totalWords = Array.from(speakerWords.values()).reduce((a, b) => a + b, 0);
  const durationSeconds = turns.length > 0
    ? turns[turns.length - 1].timestampSeconds - turns[0].timestampSeconds
    : 0;

  const speakers = new Map<string, SpeakerStats>();
  for (const [name, words] of speakerWords) {
    const turnCount = speakerTurns.get(name) || 0;
    speakers.set(name, {
      name,
      turnCount,
      wordCount: words,
      questionCount: speakerQuestions.get(name) || 0,
      talkRatio: totalWords > 0 ? Math.round(words / totalWords * 100) : 0,
      longestMonologue: speakerLongestMono.get(name) || 0,
      avgTurnLength: turnCount > 0 ? Math.round(words / turnCount) : 0,
    });
  }

  return { turns, speakers, totalTurns: turns.length, totalWords, durationSeconds };
}

/** Identify the AE speaker from a parsed transcript */
export function identifyAE(parsed: ParsedTranscript, recorderName: string): SpeakerStats | undefined {
  const firstName = recorderName.split(' ')[0];
  for (const [name, stats] of parsed.speakers) {
    if (name.includes(firstName) || name.includes(recorderName)) {
      return stats;
    }
  }
  return undefined;
}

/** Get prospect speakers (everyone except the AE) */
export function getProspectStats(parsed: ParsedTranscript, recorderName: string): SpeakerStats {
  const firstName = recorderName.split(' ')[0];
  let totalTurns = 0, totalWords = 0, totalQuestions = 0, longestMono = 0;

  for (const [name, stats] of parsed.speakers) {
    if (name.includes(firstName) || name.includes(recorderName)) continue;
    totalTurns += stats.turnCount;
    totalWords += stats.wordCount;
    totalQuestions += stats.questionCount;
    longestMono = Math.max(longestMono, stats.longestMonologue);
  }

  return {
    name: 'Prospect(s)',
    turnCount: totalTurns,
    wordCount: totalWords,
    questionCount: totalQuestions,
    talkRatio: parsed.totalWords > 0 ? Math.round(totalWords / parsed.totalWords * 100) : 0,
    longestMonologue: longestMono,
    avgTurnLength: totalTurns > 0 ? Math.round(totalWords / totalTurns) : 0,
  };
}
