import type { AppConfig } from './config';

const TOKEN_KEY = 'cognito_id_token';
const ACCESS_TOKEN_KEY = 'cognito_access_token';
const EXPIRY_KEY = 'cognito_token_expiry';
const USERNAME_KEY = 'cognito_username';

export interface TokenProvider { getIdToken(): string | null; }
export class LocalStorageTokenProvider implements TokenProvider {
  getIdToken() {
    const token = localStorage.getItem(TOKEN_KEY);
    const expiry = Number(localStorage.getItem(EXPIRY_KEY) ?? 0);
    if (!token || (expiry && expiry <= Math.floor(Date.now() / 1000))) return null;
    return token;
  }
}

export function hasConfiguredAuthentication(config: AppConfig) {
  return Boolean(
    config.cognitoRegion &&
    config.cognitoUserPoolId &&
    config.cognitoUserPoolClientId
  );
}

export async function signIn(
  config: AppConfig,
  username: string,
  password: string
) {
  if (!hasConfiguredAuthentication(config)) {
    throw new Error('Cognito authentication is not configured');
  }
  const response = await fetch(
    `https://cognito-idp.${config.cognitoRegion}.amazonaws.com/`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth'
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: config.cognitoUserPoolClientId,
        AuthParameters: {
          USERNAME: username,
          PASSWORD: password
        }
      })
    }
  );
  const result = await response.json() as {
    AuthenticationResult?: {
      IdToken: string;
      AccessToken: string;
      ExpiresIn?: number;
    };
    message?: string;
  };
  if (!response.ok || !result.AuthenticationResult) {
    throw new Error(result.message || 'Authentication failed');
  }
  const expiresAt =
    Math.floor(Date.now() / 1000) +
    (result.AuthenticationResult.ExpiresIn ?? 3600);
  localStorage.setItem(TOKEN_KEY, result.AuthenticationResult.IdToken);
  localStorage.setItem(ACCESS_TOKEN_KEY, result.AuthenticationResult.AccessToken);
  localStorage.setItem(EXPIRY_KEY, String(expiresAt));
  localStorage.setItem(USERNAME_KEY, username);
}

export function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

export function currentUsername() {
  return localStorage.getItem(USERNAME_KEY);
}
