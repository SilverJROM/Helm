import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KlooDiscoveryService } from './kloo-discovery-service.js';

// ---------------------------------------------------------------------------
// Fixture profiles.json — mirrors the real ~/.config/kloo/profiles.json shape:
// a `providers` block keyed by route name, each with `endpoint` (+ optional
// `apiKey` / `models{}`). Written to a temp dir; NEVER touches the real config
// or the real network — all fetches go through an injected fetchImpl mock.
// ---------------------------------------------------------------------------
function writeFixtureProfiles(dir: string, overrides?: any) {
  const profiles = overrides ?? {
    providers: {
      lmstudio: {
        endpoint: 'http://192.168.254.165:1234/v1',
        apiKey: '${LM_STUDIO_TOKEN}',
        models: { 'qwen-coder': { model: 'qwen3-coder-30b-a3b-instruct' }, qwen35: { model: 'qwen/qwen3.5-9b' } }
      },
      llamacpp: {
        endpoint: 'http://127.0.0.1:18531/v1'
      },
      openrouter: {
        endpoint: 'https://openrouter.ai/api/v1',
        apiKey: '${OPENROUTER_API_KEY}'
      }
    }
  };
  const file = path.join(dir, 'profiles.json');
  fs.writeFileSync(file, JSON.stringify(profiles, null, 2));
  return file;
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-kloo-b2-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('B2 KlooDiscoveryService — listRoutes (parses fixture profiles.json)', () => {
  let tmp: { dir: string; cleanup: () => void };
  afterEach(() => tmp?.cleanup());

  it('parses the 3 routes from the providers block', () => {
    tmp = makeTempDir();
    const profilesPath = writeFixtureProfiles(tmp.dir);
    const svc = new KlooDiscoveryService({ profilesPath });
    const routes = svc.listRoutes();
    expect(routes).toEqual(
      expect.arrayContaining([
        { name: 'lmstudio', endpoint: 'http://192.168.254.165:1234/v1' },
        { name: 'llamacpp', endpoint: 'http://127.0.0.1:18531/v1' },
        { name: 'openrouter', endpoint: 'https://openrouter.ai/api/v1' }
      ])
    );
    expect(routes.length).toBe(3);
  });

  it('returns [] (never throws) when profiles.json is absent', () => {
    tmp = makeTempDir();
    const svc = new KlooDiscoveryService({ profilesPath: path.join(tmp.dir, 'does-not-exist.json') });
    expect(svc.listRoutes()).toEqual([]);
  });

  it('returns [] (never throws) when profiles.json is malformed', () => {
    tmp = makeTempDir();
    const file = path.join(tmp.dir, 'profiles.json');
    fs.writeFileSync(file, '{ not valid json');
    const svc = new KlooDiscoveryService({ profilesPath: file });
    expect(svc.listRoutes()).toEqual([]);
  });
});

describe('B2 KlooDiscoveryService — listModels (mocked fetch, no real network)', () => {
  let tmp: { dir: string; cleanup: () => void };
  afterEach(() => tmp?.cleanup());

  it('returns live models on 200 (openrouter, key expanded from OPENROUTER_API_KEY)', async () => {
    tmp = makeTempDir();
    const profilesPath = writeFixtureProfiles(tmp.dir);
    const calls: { url: string; headers: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, headers: init.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'deepseek/deepseek-v4-flash' }, { id: 'z-ai/glm-4.5-air' }] })
      } as any;
    });
    const svc = new KlooDiscoveryService({ profilesPath, fetchImpl: fetchImpl as any });
    process.env.OPENROUTER_API_KEY = 'test-key-123';
    try {
      const result = await svc.listModels('openrouter');
      expect(result.cached).toBe(false);
      expect(result.models).toEqual(['deepseek/deepseek-v4-flash', 'z-ai/glm-4.5-air']);
      expect(result.note).toBeUndefined();
      expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models');
      expect(calls[0].headers.Authorization).toBe('Bearer test-key-123');
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('expands ${OPENROUTER_API_KEY} from Helm .env-style openrouter_api fallback', async () => {
    tmp = makeTempDir();
    const profilesPath = writeFixtureProfiles(tmp.dir);
    let seenAuth: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      seenAuth = init.headers.Authorization;
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
    });
    const svc = new KlooDiscoveryService({ profilesPath, fetchImpl: fetchImpl as any });
    delete process.env.OPENROUTER_API_KEY;
    process.env.openrouter_api = 'sk-or-lowercase-env-key';
    try {
      await svc.listModels('openrouter');
      expect(seenAuth).toBe('Bearer sk-or-lowercase-env-key');
    } finally {
      delete process.env.openrouter_api;
    }
  });

  it('falls back to profiles.json models{} with a note when the endpoint errors (lmstudio)', async () => {
    tmp = makeTempDir();
    const profilesPath = writeFixtureProfiles(tmp.dir);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) } as any));
    const svc = new KlooDiscoveryService({ profilesPath, fetchImpl: fetchImpl as any });
    const result = await svc.listModels('lmstudio');
    expect(result.cached).toBe(false);
    expect(result.models.sort()).toEqual(['qwen-coder', 'qwen35']);
    expect(result.note).toMatch(/route offline/);
  });

  it('falls back to [] + offline note when the endpoint errors and no models{} configured (llamacpp)', async () => {
    tmp = makeTempDir();
    const profilesPath = writeFixtureProfiles(tmp.dir);
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const svc = new KlooDiscoveryService({ profilesPath, fetchImpl: fetchImpl as any });
    const result = await svc.listModels('llamacpp');
    expect(result.models).toEqual([]);
    expect(result.note).toBe('route offline / server not running');
  });

  it('returns [] + note for an unknown/unconfigured route (no throw)', async () => {
    tmp = makeTempDir();
    const profilesPath = writeFixtureProfiles(tmp.dir);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) } as any));
    const svc = new KlooDiscoveryService({ profilesPath, fetchImpl: fetchImpl as any });
    const result = await svc.listModels('not-a-real-route');
    expect(result.models).toEqual([]);
    expect(result.note).toBe('route offline / server not running');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches within TTL (2nd call cached:true, no 2nd fetch)', async () => {
    tmp = makeTempDir();
    const profilesPath = writeFixtureProfiles(tmp.dir);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) } as any));
    const svc = new KlooDiscoveryService({ profilesPath, fetchImpl: fetchImpl as any, ttlMs: 60_000 });
    const first = await svc.listModels('llamacpp');
    const second = await svc.listModels('llamacpp');
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.models).toEqual(['m1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refresh:true bypasses the cache and re-fetches', async () => {
    tmp = makeTempDir();
    const profilesPath = writeFixtureProfiles(tmp.dir);
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      return { ok: true, status: 200, json: async () => ({ data: [{ id: `m${n}` }] }) } as any;
    });
    const svc = new KlooDiscoveryService({ profilesPath, fetchImpl: fetchImpl as any, ttlMs: 60_000 });
    const first = await svc.listModels('llamacpp');
    const second = await svc.listModels('llamacpp', { refresh: true });
    expect(first.models).toEqual(['m1']);
    expect(second.cached).toBe(false);
    expect(second.models).toEqual(['m2']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('B2 KlooDiscoveryService — validate (reuses listModels)', () => {
  let tmp: { dir: string; cleanup: () => void };
  afterEach(() => tmp?.cleanup());

  it('ok:true when route reachable and model present in live catalog', async () => {
    tmp = makeTempDir();
    const profilesPath = writeFixtureProfiles(tmp.dir);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'z-ai/glm-4.5-air' }] }) } as any));
    const svc = new KlooDiscoveryService({ profilesPath, fetchImpl: fetchImpl as any });
    const result = await svc.validate('llamacpp', 'z-ai/glm-4.5-air');
    expect(result).toEqual({ ok: true });
  });

  it('ok:false when the model is absent from the live catalog', async () => {
    tmp = makeTempDir();
    const profilesPath = writeFixtureProfiles(tmp.dir);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'some-other-model' }] }) } as any));
    const svc = new KlooDiscoveryService({ profilesPath, fetchImpl: fetchImpl as any });
    const result = await svc.validate('llamacpp', 'z-ai/glm-4.5-air');
    expect(result.ok).toBe(false);
  });

  it('ok:false for an unknown route (no throw)', async () => {
    tmp = makeTempDir();
    const profilesPath = writeFixtureProfiles(tmp.dir);
    const svc = new KlooDiscoveryService({ profilesPath, fetchImpl: vi.fn() as any });
    const result = await svc.validate('nope', 'x');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown route/);
  });
});
