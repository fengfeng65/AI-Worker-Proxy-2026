import { Env, ProviderConfig } from './types';

interface ModelListResponse {
  data?: Array<{ id?: string; [key: string]: unknown }>;
}

interface CacheEntry {
  expiresAt: number;
  models: string[];
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getApiKeyValues(config: ProviderConfig, env: Env): string[] {
  return config.apiKeys
    .map((name) => env[name])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function cacheKey(config: ProviderConfig): string {
  return [
    config.provider,
    config.baseUrl || '',
    ...config.apiKeys,
  ].join('|');
}

export async function discoverModels(config: ProviderConfig, env: Env): Promise<string[]> {
  if (config.provider !== 'openai-compatible' || !config.baseUrl) {
    return [];
  }

  const key = cacheKey(config);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }

  const apiKeys = getApiKeyValues(config, env);
  const models = new Set<string>();

  // Some compatible endpoints may not require authentication.
  const keysToTry = apiKeys.length > 0 ? apiKeys : [''];

  for (const apiKey of keysToTry) {
    try {
      const base = config.baseUrl.replace(/\/+$/, '');
      const response = await fetch(`${base}/models`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      });

      if (!response.ok) {
        console.warn(`[ModelDiscovery] ${config.baseUrl}/models returned ${response.status}`);
        continue;
      }

      const payload = (await response.json()) as ModelListResponse;
      for (const item of payload.data || []) {
        if (item && typeof item.id === 'string' && item.id.trim()) {
          models.add(item.id);
        }
      }

      if (models.size > 0) {
        break;
      }
    } catch (error) {
      console.warn(`[ModelDiscovery] Failed to query ${config.baseUrl}/models:`, error);
    }
  }

  const result = [...models];
  cache.set(key, {
    models: result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return result;
}

export function clearModelDiscoveryCache(): void {
  cache.clear();
}
