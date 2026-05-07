import { upstreamFailure } from './errors';

export interface HttpJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
}

export interface HttpJsonResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.HTTP_TIMEOUT_MS || '15000', 10);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function requestJson<T>(url: string, options: HttpJsonOptions = {}): Promise<HttpJsonResponse<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryCount = 0,
    retryDelayMs = 250,
  } = options;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      const text = await response.text();
      let data: T;

      try {
        data = (text ? JSON.parse(text) : {}) as T;
      } catch (error) {
        upstreamFailure(`Upstream response parse failed: ${String(error)}`, 'UPSTREAM_PARSE_ERROR');
      }

      if (!response.ok && attempt < retryCount && isRetryable(response.status)) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      return {
        status: response.status,
        headers: response.headers,
        data,
      };
    } catch (error) {
      if (attempt < retryCount) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message === 'This operation was aborted') {
        upstreamFailure('Upstream request timed out', 'UPSTREAM_TIMEOUT');
      }
      upstreamFailure(`Upstream request failed: ${message}`, 'UPSTREAM_REQUEST_FAILED');
    } finally {
      clearTimeout(timeout);
    }
  }

  upstreamFailure();
}
