export type HttpMethod = 'GET' | 'POST' | 'PATCH';

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
  ok: boolean;
}

function extractApiErrorDetail(data: unknown): string | null {
  if (typeof data !== 'object' || data == null) return null;

  const obj = data as {
    message?: unknown;
    Message?: unknown;
    Errors?: Array<{
      Code?: unknown;
      Message?: unknown;
      Params?: unknown;
      Detail?: unknown;
    }>;
  };

  if (typeof obj.message === 'string' && obj.message.trim() !== '') return obj.message;
  if (typeof obj.Message === 'string' && obj.Message.trim() !== '') return obj.Message;

  if (Array.isArray(obj.Errors) && obj.Errors.length > 0) {
    const first = obj.Errors[0];
    const code = typeof first?.Code === 'string' ? first.Code : 'unknown_code';
    const message = typeof first?.Message === 'string' ? first.Message : 'Sin detalle';
    const params = Array.isArray(first?.Params) ? first.Params.join(', ') : '';
    const detail = typeof first?.Detail === 'string' ? first.Detail : '';

    const parts = [`${code}: ${message}`];
    if (params) parts.push(`params=${params}`);
    if (detail) parts.push(detail);
    return parts.join(' | ');
  }

  return null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cliente HTTP con reintentos (429/5xx), timeout y tipado. Falla explícito si algo sale mal.
 */
export async function request<T = unknown>(
  method: HttpMethod,
  url: string,
  body?: object,
  options: HttpOptions = {}
): Promise<HttpResponse<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      let data: T;
      const text = await res.text();
      if (text.length > 0) {
        try {
          data = JSON.parse(text) as T;
        } catch {
          throw new Error(`Respuesta no JSON de ${url}: ${text.slice(0, 200)}`);
        }
      } else {
        data = undefined as T;
      }

      const response: HttpResponse<T> = {
        status: res.status,
        data,
        ok: res.ok,
      };

      if (res.ok) return response;

      if (isRetryable(res.status) && attempt < retries) {
        await sleep(Math.min(1000 * 2 ** attempt, 10_000));
        lastError = new Error(`HTTP ${res.status} (reintento ${attempt + 1}/${retries})`);
        continue;
      }

      const detail = extractApiErrorDetail(data);
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries && (lastError.name === 'AbortError' || lastError.message.includes('fetch'))) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error('Error HTTP desconocido');
}

export function get<T>(url: string, options?: HttpOptions): Promise<HttpResponse<T>> {
  return request<T>('GET', url, undefined, options);
}

export function post<T>(url: string, body: object, options?: HttpOptions): Promise<HttpResponse<T>> {
  return request<T>('POST', url, body, options);
}

export function patch<T>(url: string, body: object, options?: HttpOptions): Promise<HttpResponse<T>> {
  return request<T>('PATCH', url, body, options);
}
