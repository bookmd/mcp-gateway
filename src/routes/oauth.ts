import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createAuthUrl, handleCallback, initOAuthClient } from '../auth/oauth-client.js';

declare module 'fastify' {
  interface Session {
    oauth_code_verifier?: string;
    oauth_state?: string;
    oauth_nonce?: string;
    access_token?: string;
    id_token?: string;
    expires_at?: number;
    authenticated_at?: number;
    email?: string;
    hd?: string;
  }
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  await initOAuthClient();

  app.get('/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { codeVerifier, state, nonce, authUrl } = createAuthUrl();

    request.session.set('oauth_code_verifier', codeVerifier);
    request.session.set('oauth_state', state);
    request.session.set('oauth_nonce', nonce);

    return reply.redirect(authUrl);
  });

  app.get('/auth/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = new URLSearchParams(request.url.split('?')[1]);

      const stored = {
        codeVerifier: request.session.get('oauth_code_verifier') as string,
        state: request.session.get('oauth_state') as string,
        nonce: request.session.get('oauth_nonce') as string
      };

      if (!stored.codeVerifier || !stored.state) {
        return reply.code(400).send({ error: 'Invalid session state' });
      }

      const result = await handleCallback(params, stored);

      await request.session.regenerate();

      request.session.set('access_token', result.accessToken);
      request.session.set('id_token', result.idToken);
      request.session.set('expires_at', result.expiresAt);
      request.session.set('authenticated_at', Date.now());
      request.session.set('email', result.email);
      request.session.set('hd', result.hd);

      request.session.set('oauth_code_verifier', undefined);
      request.session.set('oauth_state', undefined);
      request.session.set('oauth_nonce', undefined);

      return reply.send({
        success: true,
        email: result.email,
        message: 'Authentication successful. You can now connect from Cursor.'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authentication failed';
      return reply.code(401).send({ error: message });
    }
  });

  app.get('/auth/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const email = request.session.get('email');
    const authenticatedAt = request.session.get('authenticated_at') as number | undefined;
    const expiresAt = request.session.get('expires_at') as number | undefined;

    if (!email || !authenticatedAt) {
      return reply.send({ authenticated: false });
    }

    const weekInMs = 7 * 24 * 60 * 60 * 1000;
    const weeklyExpired = Date.now() - authenticatedAt >= weekInMs;
    const tokenExpired = expiresAt ? Date.now() >= expiresAt : true;

    return reply.send({
      authenticated: !weeklyExpired && !tokenExpired,
      email,
      authenticatedAt: new Date(authenticatedAt).toISOString(),
      weeklyExpiresAt: new Date(authenticatedAt + weekInMs).toISOString(),
      tokenExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
    });
  });

  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    await request.session.destroy();
    return reply.send({ success: true });
  });
}
