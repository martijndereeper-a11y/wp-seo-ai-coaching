/**
 * Claap API Client
 *
 * A typed client for the Claap API (https://docs.claap.io).
 * Supports all v1 endpoints: recordings CRUD, transcripts, and workspace info.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ClaapClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface ClaapPagination {
  totalCount: number;
  nextCursor?: string;
}

export interface ClaapChannel {
  id: string;
  name: string;
}

export interface ClaapWorkspace {
  id: string;
  name: string;
}

export interface ClaapRecorder {
  id: string;
  name: string;
  email: string;
  attended: boolean;
}

export interface ClaapParticipant {
  name: string;
  email: string;
  isOrganizer?: boolean;
}

export interface ClaapMeeting {
  conferenceUrl?: string;
  startingAt: string;
  endingAt?: string;
  type?: 'internal' | 'external';
  participants: ClaapParticipant[];
}

export interface ClaapTranscriptRef {
  langIso2: string;
  isTranscript: boolean;
  isActive: boolean;
  url: string;
  textUrl: string;
}

export interface ClaapVideo {
  url: string;
}

export interface ClaapActionItem {
  items: string[];
  langIso2: string;
}

export interface ClaapKeyTakeaway {
  langIso2: string;
  text: string;
}

export interface ClaapOutline {
  langIso2: string;
  text: string;
}

export interface ClaapInsightTemplate {
  templateTitle: string;
  insights: unknown[];
}

/** New flat AI-field structure. Replaces insightTemplates as of Claap's 2026-06-26 API change. */
export interface ClaapAiField {
  title: string;
  description: string;
}

export interface ClaapCompany {
  id: string;
  name: string;
}

export interface ClaapDeal {
  id: string;
  name: string;
}

export interface ClaapCrmInfo {
  crm: string;
  deal: ClaapDeal;
}

export interface ClaapRecording {
  id: string;
  title: string;
  state: 'Ready';
  createdAt: string;
  durationSeconds: number;
  labels: string[];
  thumbnailUrl: string;
  url: string;
  video: ClaapVideo;
  recorder: ClaapRecorder;
  channel: ClaapChannel;
  workspace: ClaapWorkspace;
  meeting?: ClaapMeeting;
  transcripts: ClaapTranscriptRef[];
  actionItems?: ClaapActionItem[];
  keyTakeaways?: ClaapKeyTakeaway[];
  outlines?: ClaapOutline[];
  /** @deprecated Claap stopped populating this on 2026-06-26. Use aiFields. */
  insightTemplates?: ClaapInsightTemplate[];
  aiFields?: ClaapAiField[];
  companies?: ClaapCompany[];
  crmInfo?: ClaapCrmInfo;
  deal?: ClaapDeal;
}

export interface ClaapUploadingRecording {
  id: string;
  title?: string;
  state: 'Empty' | 'Uploaded' | 'Failed';
  createdAt: string;
  url: string;
  upload: { url: string; metaUrl?: string };
  recorder: ClaapRecorder;
  channel: ClaapChannel;
  workspace: ClaapWorkspace;
}

export interface ListRecordingsParams {
  channelId?: string;
  createdAfter?: string;
  createdBefore?: string;
  cursor?: string;
  labels?: string;
  limit?: number;
  recorderEmail?: string;
  recorderId?: string;
  sort?: 'created_asc' | 'created_desc' | 'duration_asc' | 'duration_desc' | 'title_asc' | 'title_desc';
  /** Request the new flat aiFields structure instead of deprecated insightTemplates. */
  returnAiFields?: boolean;
}

export interface ListRecordingsResponse {
  result: {
    recordings: ClaapRecording[];
    pagination: ClaapPagination;
  };
}

export interface GetRecordingResponse {
  result: {
    recording: ClaapRecording | ClaapUploadingRecording;
  };
}

export interface TranscriptWord {
  word: string;
  startedAt: number;
  endedAt: number;
}

export interface TranscriptSegment {
  startedAt: number;
  endedAt: number;
  speaker: string;
  text: string;
  languageCode: string;
  words: TranscriptWord[];
}

export interface ClaapTranscript {
  segments: TranscriptSegment[];
  languageCode: string;
}

export interface GetTranscriptResponse {
  result: {
    transcript: ClaapTranscript;
  };
}

export interface CreateRecordingParams {
  authorEmail: string;
  title?: string;
  channelId?: string;
  downloadUrl?: string;
  transcript?: { type: 'upload' };
  meeting?: {
    startedAt: string;
    endedAt?: string;
    participants?: ClaapParticipant[];
  };
  deal?: {
    type: 'attio' | 'hubspot' | 'pipedrive' | 'salesforce';
    id: string;
  };
}

export interface CreateRecordingResponse {
  result: {
    recording: ClaapUploadingRecording;
  };
}

export interface DeleteRecordingResponse {
  result: {
    ok: boolean;
  };
}

export interface ClaapWorkspaceInfo {
  id: string;
  name: string;
  createdAt: string;
  membersCount: number;
  recordingsCount: number;
}

export interface GetWorkspaceResponse {
  result: {
    workspace: ClaapWorkspaceInfo;
  };
}

// ─── Error ──────────────────────────────────────────────────────────────────────

export class ClaapApiError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ClaapApiError';
    this.status = status;
    this.body = body;
  }
}

// ─── Client ─────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://api.claap.io';

export class ClaapClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: ClaapClientOptions) {
    if (!options.apiKey) {
      throw new Error('Claap API key is required. Set CLAAP_API_KEY or pass apiKey option.');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const url = `${this.baseUrl}${path}`;
      const headers: Record<string, string> = {
        'X-Claap-Key': this.apiKey,
        'Accept': 'application/json',
      };
      if (body) {
        headers['Content-Type'] = 'application/json';
      }

      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = res.headers.get('retry-after');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.min(1000 * 2 ** attempt, 30000);
        console.warn(`Rate limited on ${method} ${path}, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      if (!res.ok) {
        let errorBody: unknown;
        try { errorBody = await res.json(); } catch { /* ignore */ }
        throw new ClaapApiError(
          `Claap API ${method} ${path} failed with ${res.status}`,
          res.status,
          errorBody,
        );
      }

      return res.json() as Promise<T>;
    }

    throw new ClaapApiError(`Claap API ${method} ${path} failed after ${maxRetries} retries (429)`, 429);
  }

  private buildQuery(params: Record<string, unknown>): string {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
    if (entries.length === 0) return '';
    const qs = entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    return `?${qs}`;
  }

  // ── Recordings ────────────────────────────────────────────────────────────

  /** List all recordings in the workspace with optional filters and pagination. */
  async listRecordings(params: ListRecordingsParams = {}): Promise<ListRecordingsResponse> {
    const query = this.buildQuery(params as Record<string, unknown>);
    return this.request<ListRecordingsResponse>('GET', `/v1/recordings${query}`);
  }

  /** Get full details for a single recording, including AI insights and CRM data. */
  async getRecording(recordingId: string, options?: { returnAiFields?: boolean }): Promise<GetRecordingResponse> {
    const query = this.buildQuery({ returnAiFields: options?.returnAiFields });
    return this.request<GetRecordingResponse>('GET', `/v1/recordings/${encodeURIComponent(recordingId)}${query}`);
  }

  /** Get the transcript for a recording in JSON (default) or text format. */
  async getTranscript(
    recordingId: string,
    options?: { lang?: string; format?: 'json' | 'text' },
  ): Promise<GetTranscriptResponse | string> {
    const query = this.buildQuery({
      lang: options?.lang,
      format: options?.format,
    });
    const path = `/v1/recordings/${encodeURIComponent(recordingId)}/transcript${query}`;

    if (options?.format === 'text') {
      const url = `${this.baseUrl}${path}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'X-Claap-Key': this.apiKey, 'Accept': 'text/plain' },
      });
      if (!res.ok) {
        throw new ClaapApiError(`Claap API GET ${path} failed with ${res.status}`, res.status);
      }
      return res.text();
    }

    return this.request<GetTranscriptResponse>('GET', path);
  }

  /** Create a new recording. Upload video via the returned upload.url or provide a downloadUrl. */
  async createRecording(params: CreateRecordingParams): Promise<CreateRecordingResponse> {
    return this.request<CreateRecordingResponse>('POST', '/v1/recordings', params);
  }

  /** Permanently delete a recording. This action cannot be undone. */
  async deleteRecording(recordingId: string): Promise<DeleteRecordingResponse> {
    return this.request<DeleteRecordingResponse>('DELETE', `/v1/recordings/${encodeURIComponent(recordingId)}`);
  }

  // ── Workspace ─────────────────────────────────────────────────────────────

  /** Get workspace details: name, member count, recording count. */
  async getWorkspace(): Promise<GetWorkspaceResponse> {
    return this.request<GetWorkspaceResponse>('GET', '/v1/workspaces/mine');
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  /** Manually trigger a webhook by ID. */
  async triggerWebhook(webhookId: string): Promise<unknown> {
    return this.request<unknown>('POST', `/v1/webhooks/${encodeURIComponent(webhookId)}/trigger`);
  }

  // ── Convenience ───────────────────────────────────────────────────────────

  /** Iterate through all recordings using cursor-based pagination. */
  async *listAllRecordings(params: Omit<ListRecordingsParams, 'cursor'> = {}): AsyncGenerator<ClaapRecording> {
    let cursor: string | undefined;
    do {
      const response = await this.listRecordings({ ...params, cursor });
      for (const recording of response.result.recordings) {
        yield recording;
      }
      cursor = response.result.pagination.nextCursor;
    } while (cursor);
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────────

/**
 * Create a ClaapClient from environment variables or a local key file.
 *
 * Resolution order:
 *   1. Explicit `apiKey` override
 *   2. CLAAP_API_KEY environment variable
 *   3. ~/.config/document-hub/claap_api_key file
 */
export function createClaapClient(overrides?: Partial<ClaapClientOptions>): ClaapClient {
  const keyFile = join(homedir(), '.config', 'document-hub', 'claap_api_key');
  const apiKey = overrides?.apiKey
    ?? process.env.CLAAP_API_KEY
    ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf-8').trim() : '');

  return new ClaapClient({
    apiKey,
    baseUrl: overrides?.baseUrl,
  });
}
