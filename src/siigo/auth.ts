import { z } from 'zod';
import { post } from '../Core/http.js';
import { SiigoError } from '../Core/errors.js';
import type { Env } from '../config/env.js';


const AuthResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
});

/** Obtiene access token de Siigo (OAuth2 client_credentials). */
export async function getSiigoAccessToken(
  env: Env,
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<string> {
  const attempts: Array<{ name: string; body: object }> = [
    {
      name: 'oauth_client_credentials',
      body: {
        grant_type: 'client_credentials',
        client_id: env.siigo.clientId,
        client_secret: env.siigo.clientSecret,
      },
    },
    {
      name: 'usuario_api_access_key',
      body: {
        username: env.siigo.clientId,
        access_key: env.siigo.clientSecret,
      },
    },
  ];

  const errors: string[] = [];

  for (const attempt of attempts) {
    try {
      const res = await post<unknown>(env.siigo.authUrl, attempt.body, {
        headers: { 'Partner-Id': env.siigo.partnerId },
        timeoutMs: options.timeoutMs,
        retries: options.retries,
      });

      if (!res.ok || res.status !== 200) {
        errors.push(`${attempt.name}: HTTP ${res.status}`);
        continue;
      }

      const parsed = AuthResponseSchema.safeParse(res.data);
      if (!parsed.success) {
        errors.push(`${attempt.name}: respuesta inválida (${parsed.error.message})`);
        continue;
      }

      return parsed.data.access_token;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${attempt.name}: ${message}`);
      continue;
    }
  }

  throw new SiigoError(`Auth falló en todos los formatos probados: ${errors.join(' | ')}`);
}
