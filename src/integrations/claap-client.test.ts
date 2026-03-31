import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaapClient, ClaapApiError } from './claap-client.js';
import type {
  ListRecordingsResponse,
  GetRecordingResponse,
  GetTranscriptResponse,
  CreateRecordingResponse,
  DeleteRecordingResponse,
  GetWorkspaceResponse,
} from './claap-client.js';

// ─── Helpers ────────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function createClient() {
  return new ClaapClient({ apiKey: 'cla_test123' });
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('ClaapClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('throws if apiKey is empty', () => {
      expect(() => new ClaapClient({ apiKey: '' })).toThrow('Claap API key is required');
    });

    it('creates client with valid apiKey', () => {
      const client = createClient();
      expect(client).toBeInstanceOf(ClaapClient);
    });
  });

  describe('listRecordings', () => {
    it('calls GET /v1/recordings with no params', async () => {
      const responseBody: ListRecordingsResponse = {
        result: {
          recordings: [],
          pagination: { totalCount: 0 },
        },
      };
      const fetchMock = mockFetch(responseBody);
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      const result = await client.listRecordings();

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.claap.io/v1/recordings');
      expect(opts.method).toBe('GET');
      expect(opts.headers['X-Claap-Key']).toBe('cla_test123');
      expect(result.result.recordings).toEqual([]);
    });

    it('passes query parameters', async () => {
      const fetchMock = mockFetch({ result: { recordings: [], pagination: { totalCount: 0 } } });
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      await client.listRecordings({ limit: 10, sort: 'created_desc', labels: 'demo,sales' });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('limit=10');
      expect(url).toContain('sort=created_desc');
      expect(url).toContain('labels=demo%2Csales');
    });
  });

  describe('getRecording', () => {
    it('calls GET /v1/recordings/{id}', async () => {
      const responseBody: GetRecordingResponse = {
        result: {
          recording: {
            id: 'rec_123',
            title: 'Test Meeting',
            state: 'Ready',
            createdAt: '2025-01-01T00:00:00Z',
            durationSeconds: 300,
            labels: [],
            thumbnailUrl: 'https://example.com/thumb.jpg',
            url: 'https://app.claap.io/rec_123',
            video: { url: 'https://example.com/video.mp4' },
            recorder: { id: 'u1', name: 'Alice', email: 'alice@test.com', attended: true },
            channel: { id: 'ch1', name: 'General' },
            workspace: { id: 'ws1', name: 'My Workspace' },
            transcripts: [],
          },
        },
      };
      const fetchMock = mockFetch(responseBody);
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      const result = await client.getRecording('rec_123');

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.claap.io/v1/recordings/rec_123');
      expect(result.result.recording.id).toBe('rec_123');
    });
  });

  describe('getTranscript', () => {
    it('returns JSON transcript by default', async () => {
      const responseBody: GetTranscriptResponse = {
        result: {
          transcript: {
            segments: [
              {
                startedAt: 0,
                endedAt: 2.5,
                speaker: 'speaker_1',
                text: 'Hello!',
                languageCode: 'en',
                words: [{ word: 'Hello!', startedAt: 0, endedAt: 2.5 }],
              },
            ],
            languageCode: 'en',
          },
        },
      };
      const fetchMock = mockFetch(responseBody);
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      const result = await client.getTranscript('rec_123');

      expect(typeof result).toBe('object');
      expect((result as GetTranscriptResponse).result.transcript.segments).toHaveLength(1);
    });

    it('returns plain text when format is text', async () => {
      const textBody = '00:00 speaker_1: Hello!';
      const fetchMock = mockFetch(textBody);
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      const result = await client.getTranscript('rec_123', { format: 'text' });

      expect(typeof result).toBe('string');
      expect(result).toContain('Hello!');

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers['Accept']).toBe('text/plain');
    });

    it('passes lang query parameter', async () => {
      const fetchMock = mockFetch({ result: { transcript: { segments: [], languageCode: 'fr' } } });
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      await client.getTranscript('rec_123', { lang: 'fr' });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('lang=fr');
    });
  });

  describe('createRecording', () => {
    it('calls POST /v1/recordings with body', async () => {
      const responseBody: CreateRecordingResponse = {
        result: {
          recording: {
            id: 'rec_new',
            state: 'Empty',
            createdAt: '2025-01-01T00:00:00Z',
            url: 'https://app.claap.io/rec_new',
            upload: { url: 'https://upload.claap.io/presigned' },
            recorder: { id: 'u1', name: 'Alice', email: 'alice@test.com', attended: false },
            channel: { id: 'ch1', name: 'General' },
            workspace: { id: 'ws1', name: 'My Workspace' },
          },
        },
      };
      const fetchMock = mockFetch(responseBody);
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      const result = await client.createRecording({
        authorEmail: 'alice@test.com',
        title: 'New Recording',
      });

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.claap.io/v1/recordings');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(opts.body)).toEqual({ authorEmail: 'alice@test.com', title: 'New Recording' });
      expect(result.result.recording.id).toBe('rec_new');
    });
  });

  describe('deleteRecording', () => {
    it('calls DELETE /v1/recordings/{id}', async () => {
      const responseBody: DeleteRecordingResponse = { result: { ok: true } };
      const fetchMock = mockFetch(responseBody);
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      const result = await client.deleteRecording('rec_123');

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.claap.io/v1/recordings/rec_123');
      expect(opts.method).toBe('DELETE');
      expect(result.result.ok).toBe(true);
    });
  });

  describe('getWorkspace', () => {
    it('calls GET /v1/workspaces/mine', async () => {
      const responseBody: GetWorkspaceResponse = {
        result: {
          workspace: {
            id: 'ws1',
            name: 'My Workspace',
            createdAt: '2024-01-01T00:00:00Z',
            membersCount: 5,
            recordingsCount: 42,
          },
        },
      };
      const fetchMock = mockFetch(responseBody);
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      const result = await client.getWorkspace();

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.claap.io/v1/workspaces/mine');
      expect(result.result.workspace.name).toBe('My Workspace');
    });
  });

  describe('triggerWebhook', () => {
    it('calls POST /v1/webhooks/{id}/trigger', async () => {
      const fetchMock = mockFetch({ ok: true });
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      await client.triggerWebhook('wh_abc');

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.claap.io/v1/webhooks/wh_abc/trigger');
      expect(opts.method).toBe('POST');
    });
  });

  describe('error handling', () => {
    it('throws ClaapApiError on non-ok response', async () => {
      const fetchMock = mockFetch({ error: 'Unauthorized' }, 401, false);
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      await expect(client.listRecordings()).rejects.toThrow(ClaapApiError);
      await expect(client.listRecordings()).rejects.toMatchObject({ status: 401 });
    });

    it('throws ClaapApiError on 429 rate limit', async () => {
      const fetchMock = mockFetch({ error: 'Too many requests' }, 429, false);
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      await expect(client.listRecordings()).rejects.toThrow(ClaapApiError);
      await expect(client.listRecordings()).rejects.toMatchObject({ status: 429 });
    });
  });

  describe('listAllRecordings', () => {
    it('iterates through paginated results', async () => {
      const page1 = {
        result: {
          recordings: [{ id: 'r1' }, { id: 'r2' }],
          pagination: { totalCount: 3, nextCursor: 'cursor_2' },
        },
      };
      const page2 = {
        result: {
          recordings: [{ id: 'r3' }],
          pagination: { totalCount: 3 },
        },
      };

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(page1) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(page2) });
      vi.stubGlobal('fetch', fetchMock);

      const client = createClient();
      const ids: string[] = [];
      for await (const rec of client.listAllRecordings()) {
        ids.push(rec.id);
      }

      expect(ids).toEqual(['r1', 'r2', 'r3']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain('cursor=cursor_2');
    });
  });

  describe('custom baseUrl', () => {
    it('uses custom baseUrl and strips trailing slash', async () => {
      const fetchMock = mockFetch({ result: { workspace: {} } });
      vi.stubGlobal('fetch', fetchMock);

      const client = new ClaapClient({ apiKey: 'cla_test', baseUrl: 'https://custom.api.com/' });
      await client.getWorkspace();

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://custom.api.com/v1/workspaces/mine');
    });
  });
});
