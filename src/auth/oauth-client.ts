import { Issuer, generators, Client } from 'openid-client';
import { oauthConfig } from '../config/oauth.js';

let client: Client;

export async function initOAuthClient(): Promise<void> {
  const googleIssuer = await Issuer.discover('https://accounts.google.com');
  client = new googleIssuer.Client({
    client_id: oauthConfig.clientId,
    client_secret: oauthConfig.clientSecret,
    redirect_uris: [oauthConfig.redirectUri],
    response_types: ['code']
  });
}

export interface AuthUrlParams {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  nonce: string;
  authUrl: string;
}

export function createAuthUrl(): AuthUrlParams {
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const state = generators.state();
  const nonce = generators.nonce();

  const authUrl = client.authorizationUrl({
    scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    hd: oauthConfig.allowedDomain
  });

  return { codeVerifier, codeChallenge, state, nonce, authUrl };
}

export interface CallbackResult {
  accessToken: string;
  idToken: string;
  expiresAt: number;
  email: string;
  hd: string;
}

export async function handleCallback(
  params: URLSearchParams,
  stored: { codeVerifier: string; state: string; nonce: string }
): Promise<CallbackResult> {
  const tokenSet = await client.callback(
    oauthConfig.redirectUri,
    Object.fromEntries(params),
    {
      code_verifier: stored.codeVerifier,
      state: stored.state,
      nonce: stored.nonce
    }
  );

  const claims = tokenSet.claims();

  if (claims.hd !== oauthConfig.allowedDomain) {
    throw new Error(`Unauthorized domain: ${claims.hd}. Only ${oauthConfig.allowedDomain} accounts allowed.`);
  }

  return {
    accessToken: tokenSet.access_token!,
    idToken: tokenSet.id_token!,
    expiresAt: tokenSet.expires_at! * 1000,
    email: claims.email as string,
    hd: claims.hd as string
  };
}
