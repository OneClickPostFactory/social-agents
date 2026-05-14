import * as https from 'node:https';

import type { RedditPost } from './types';

export type RedditPublicJsonTransport = 'auto' | 'fetch' | 'node_https';
export type RedditPublicJsonUsedTransport = 'fetch' | 'node_https';
export type RedditPublicJsonRuntime = 'cloudflare_worker' | 'node';
export type RedditPublicJsonEndpointKind = 'reddit_user' | 'subreddit';

export interface RedditPublicJsonOptions {
  endpointKind?: RedditPublicJsonEndpointKind;
  timeoutMs?: number;
  transport?: RedditPublicJsonTransport;
}

export interface RedditPublicJsonResult {
  payload: unknown;
  runtime: RedditPublicJsonRuntime;
  status: number;
  transport: RedditPublicJsonUsedTransport;
}

export class RedditPublicJsonError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context: {
      bodySnippet?: string;
      endpointKind?: RedditPublicJsonEndpointKind;
      runtime: RedditPublicJsonRuntime;
      status?: number;
      transport: RedditPublicJsonUsedTransport;
    }
  ) {
    super(message);
    this.name = 'RedditPublicJsonError';
  }
}

const DEFAULT_TIMEOUT_MS = 15000;
const REDDIT_PUBLIC_JSON_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

function runtimeKind(): RedditPublicJsonRuntime {
  return process.env.CF_WORKER_RUNTIME === 'true' ? 'cloudflare_worker' : 'node';
}

function selectedTransport(transport: RedditPublicJsonTransport | undefined): RedditPublicJsonUsedTransport {
  const runtime = runtimeKind();
  const requested = transport || 'auto';
  if (requested === 'fetch') return 'fetch';
  if (requested === 'node_https') {
    if (runtime !== 'node' || typeof https.get !== 'function') {
      throw new RedditPublicJsonError(
        'reddit_node_https_unavailable_in_runtime',
        'reddit_node_https_unavailable_in_runtime',
        { runtime, transport: 'node_https' }
      );
    }
    return 'node_https';
  }
  return runtime === 'node' && typeof https.get === 'function' ? 'node_https' : 'fetch';
}

function bodySnippet(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function statusCode(status: number, transport: RedditPublicJsonUsedTransport): string {
  if (status === 403) return 'reddit_public_json_blocked_403';
  if (status === 404) return 'reddit_public_json_not_found_404';
  if (status === 429) return 'reddit_public_json_rate_limited_429';
  return `reddit_public_json_http_${status}`;
}

function throwStatusError(
  status: number,
  text: string,
  context: {
    endpointKind?: RedditPublicJsonEndpointKind;
    runtime: RedditPublicJsonRuntime;
    transport: RedditPublicJsonUsedTransport;
  }
): never {
  const code = statusCode(status, context.transport);
  const snippet = bodySnippet(text);
  const message = snippet ? `${code}: ${snippet}` : code;
  throw new RedditPublicJsonError(code, message, {
    ...context,
    bodySnippet: snippet || undefined,
    status,
  });
}

function parseJsonBody(
  text: string,
  context: {
    endpointKind?: RedditPublicJsonEndpointKind;
    runtime: RedditPublicJsonRuntime;
    status: number;
    transport: RedditPublicJsonUsedTransport;
  }
): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RedditPublicJsonError(
      'reddit_public_json_json_parse_failed',
      `Failed to parse Reddit response: ${message}`,
      {
        ...context,
        bodySnippet: bodySnippet(text) || undefined,
      }
    );
  }
}

async function fetchRedditPublicJsonViaFetch(
  url: string,
  headers: Record<string, string>,
  options: RedditPublicJsonOptions
): Promise<RedditPublicJsonResult> {
  const runtime = runtimeKind();
  const transport = 'fetch';
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throwStatusError(response.status, text, {
      endpointKind: options.endpointKind,
      runtime,
      transport,
    });
  }
  return {
    payload: parseJsonBody(text, {
      endpointKind: options.endpointKind,
      runtime,
      status: response.status,
      transport,
    }),
    runtime,
    status: response.status,
    transport,
  };
}

function nodeHttpsGetText(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  redirects = 0
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    const req = https.get(url, { headers, timeout: timeoutMs }, res => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        const nextUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://www.reddit.com${res.headers.location}`;
        res.resume();
        nodeHttpsGetText(nextUrl, headers, timeoutMs, redirects + 1).then(resolve).catch(reject);
        return;
      }

      let text = '';
      res.on('data', chunk => {
        text += chunk;
      });
      res.on('end', () => resolve({ status, text }));
    });

    req.on('timeout', () => {
      req.destroy(new Error('reddit_public_json_timeout'));
    });
    req.on('error', reject);
  });
}

async function fetchRedditPublicJsonViaNodeHttps(
  url: string,
  headers: Record<string, string>,
  options: RedditPublicJsonOptions
): Promise<RedditPublicJsonResult> {
  const runtime = runtimeKind();
  if (runtime !== 'node' || typeof https.get !== 'function') {
    throw new RedditPublicJsonError(
      'reddit_node_https_unavailable_in_runtime',
      'reddit_node_https_unavailable_in_runtime',
      {
        endpointKind: options.endpointKind,
        runtime,
        transport: 'node_https',
      }
    );
  }

  const transport = 'node_https';
  const { status, text } = await nodeHttpsGetText(
    url,
    headers,
    options.timeoutMs || DEFAULT_TIMEOUT_MS
  );
  if (status < 200 || status >= 300) {
    throwStatusError(status, text, {
      endpointKind: options.endpointKind,
      runtime,
      transport,
    });
  }
  return {
    payload: parseJsonBody(text, {
      endpointKind: options.endpointKind,
      runtime,
      status,
      transport,
    }),
    runtime,
    status,
    transport,
  };
}

export function redditPublicJsonHeaders(): Record<string, string> {
  return { ...REDDIT_PUBLIC_JSON_HEADERS };
}

export async function fetchRedditPublicJson(
  url: string,
  options: RedditPublicJsonOptions = {}
): Promise<RedditPublicJsonResult> {
  const headers = redditPublicJsonHeaders();
  const transport = selectedTransport(options.transport);
  if (transport === 'node_https') {
    return fetchRedditPublicJsonViaNodeHttps(url, headers, options);
  }
  return fetchRedditPublicJsonViaFetch(url, headers, options);
}

export function parseRedditPublicJsonPosts(payload: unknown): RedditPost[] {
  const listing = payload as {
    data?: {
      children?: Array<{ data?: Record<string, unknown> }>;
    };
  };

  return (listing.data?.children || [])
    .map(child => child.data || {})
    .filter(post => !post.stickied && !post.is_video)
    .map(post => ({
      id: String(post.id || ''),
      title: String(post.title || ''),
      selftext: String(post.selftext || ''),
      url: String(post.url || ''),
      score: Number(post.score || 0),
      comments: Number(post.num_comments || 0),
      subreddit: String(post.subreddit || ''),
      author: String(post.author || ''),
      created: Number(post.created_utc || Date.now() / 1000),
    }));
}
