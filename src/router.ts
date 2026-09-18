import { RouteConfig, ProviderConfig, Env, OpenAIChatRequest, ProviderResponse } from './types';
import { TokenManager } from './token-manager';
import { ProxyError } from './utils/error-handler';
import { discoverModels } from './model-discovery';

const AUTO_ROUTE = '__auto__';

export class Router {
  private routes: RouteConfig;

  constructor(private env: Env) {
    this.routes = this.parseRoutesConfig();
  }

  async getAvailableModels(): Promise<Array<{
    id: string;
    object: string;
    owned_by: string;
    permission: string[];
  }>> {
    const modelNames = new Set(
      Object.keys(this.routes).filter((name) => name !== AUTO_ROUTE)
    );

    const autoProviders = this.getAutoProviders();
    const discovered = await Promise.all(
      autoProviders.map((config) => discoverModels(config, this.env))
    );

    for (const models of discovered) {
      for (const model of models) {
        modelNames.add(model);
      }
    }

    return [...modelNames].map((model) => ({
      id: model,
      object: 'model',
      owned_by: 'ai-worker-proxy',
      permission: [],
    }));
  }

  private getAutoProviders(): ProviderConfig[] {
    const explicit = this.routes[AUTO_ROUTE] || [];
    const implicit = Object.entries(this.routes)
      .filter(([name]) => name !== AUTO_ROUTE)
      .flatMap(([, configs]) =>
        configs.filter((config) => config.provider === 'openai-compatible')
      );

    const seen = new Set<string>();
    return [...explicit, ...implicit].filter((config) => {
      const key = JSON.stringify([config.provider, config.baseUrl, config.apiKeys]);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  async getProvidersForModel(model: string): Promise<ProviderConfig[]> {
    if (this.routes[model]) {
      return this.routes[model];
    }

    const autoProviders = this.getAutoProviders();
    for (const config of autoProviders) {
      const models = await discoverModels(config, this.env);
      if (models.includes(model)) {
        return [{ ...config, model }];
      }
    }

    throw new ProxyError('No providers configured for model: ' + model, 404);
  }

  async executeWithFallback(request: OpenAIChatRequest): Promise<ProviderResponse> {
    const model = request.model;
    if (!model) {
      throw new ProxyError('Model name is required', 400);
    }

    const providers = await this.getProvidersForModel(model);
    console.log('[Router] Model "' + model + '" has ' + providers.length + ' provider(s) configured');

    let lastError: any = null;

    for (let i = 0; i < providers.length; i++) {
      const config = providers[i];
      console.log(
        '[Router] Trying provider ' +
          (i + 1) +
          '/' +
          providers.length +
          ': ' +
          config.provider +
          '/' +
          config.model
      );

      try {
        const manager = new TokenManager(config, this.env);
        const response = await manager.executeWithRotation(request);

        if (response.success) {
          console.log('[Router] Success with provider: ' + config.provider + '/' + config.model);
          return response;
        }

        lastError = response.error;
        console.log(
          '[Router] Provider ' +
            config.provider +
            '/' +
            config.model +
            ' failed: ' +
            response.error
        );
      } catch (error) {
        lastError = error;
        console.error(
          '[Router] Provider ' +
            config.provider +
            '/' +
            config.model +
            ' exception:',
          error
        );
      }
    }

    return {
      success: false,
      error: 'All providers failed. Last error: ' + (lastError?.message || lastError || 'Unknown error'),
      statusCode: 500,
    };
  }

  private parseRoutesConfig(): RouteConfig {
    try {
      const configStr = this.env.ROUTES_CONFIG;
      if (!configStr) {
        throw new Error('ROUTES_CONFIG not found in environment');
      }

      const config = JSON.parse(configStr);
      console.log('[Router] Loaded routes:', Object.keys(config));
      return config;
    } catch (error) {
      console.error('[Router] Failed to parse ROUTES_CONFIG:', error);
      throw new ProxyError('Invalid ROUTES_CONFIG', 500);
    }
  }
}
