import { z } from 'zod';

const AppConfigSchema = z.object({
  protocolVersion: z.literal('2.0').default('2.0'),
  webSocketUrl: z.string(),
  apiBaseUrl: z.string().default(''),
  robotApiEndpoint: z.string().default(''),
  defaultRoomCode: z.string().default('BTL1'),
  defaultSessionKey: z.string().default('mcpserver'),
  cognitoUserPoolId: z.string().default(''),
  cognitoUserPoolClientId: z.string().default(''),
  cognitoRegion: z.string().default('')
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function resolveApiBaseUrl(configuredUrl: unknown) {
  return import.meta.env.VITE_API_BASE_URL || (typeof configuredUrl === 'string' ? configuredUrl : '') || location.origin;
}

let configPromise: Promise<AppConfig> | undefined;
export function loadConfig() {
  configPromise ??= fetch('/config.json', { cache: 'no-store' })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error(`config ${response.status}`)))
    .then((value) => AppConfigSchema.parse({
      ...value,
      webSocketUrl: import.meta.env.VITE_WEBSOCKET_URL || value.webSocketUrl ||
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/control`,
      apiBaseUrl: resolveApiBaseUrl(value.apiBaseUrl),
      cognitoUserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? value.cognitoUserPoolId,
      cognitoUserPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID ?? value.cognitoUserPoolClientId,
      cognitoRegion: import.meta.env.VITE_COGNITO_REGION ?? value.cognitoRegion
    }))
    .catch(() => AppConfigSchema.parse({
      webSocketUrl: import.meta.env.VITE_WEBSOCKET_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/control`,
      apiBaseUrl: resolveApiBaseUrl(''),
      cognitoUserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? '',
      cognitoUserPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID ?? '',
      cognitoRegion: import.meta.env.VITE_COGNITO_REGION ?? ''
    }));
  return configPromise;
}
