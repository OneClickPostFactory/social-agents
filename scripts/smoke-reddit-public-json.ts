import config from '../config';

import {
  fetchRedditPublicJson,
  parseRedditPublicJsonPosts,
  type RedditPublicJsonTransport,
} from '../src/reddit-public-json';

function argValue(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find(arg => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : '';
}

function usage(): never {
  console.error([
    'Usage:',
    '  npm run smoke:reddit-public-json -- --type=sub --source=OpenclawBot --sort=new --limit=20',
    '  npm run smoke:reddit-public-json -- --type=user --source=advanced_pudding9228 --sort=new --limit=20',
  ].join('\n'));
  process.exit(1);
}

function cleanSegment(value: string): string {
  return value
    .trim()
    .replace(/^r\//i, '')
    .replace(/^u\//i, '')
    .replace(/^@/, '')
    .split(/[/?#|]/)[0]
    .trim();
}

function transportFromArg(value: string): RedditPublicJsonTransport {
  if (value === 'fetch' || value === 'node_https' || value === 'auto') return value;
  return config.REDDIT_PUBLIC_JSON_TRANSPORT;
}

async function main(): Promise<void> {
  const type = argValue('type');
  const source = cleanSegment(argValue('source'));
  const sort = cleanSegment(argValue('sort') || 'new');
  const limit = Number.parseInt(argValue('limit') || '20', 10);
  const transport = transportFromArg(argValue('transport'));

  if (!['sub', 'user'].includes(type) || !source || !sort || !Number.isFinite(limit) || limit <= 0) {
    usage();
  }

  const url = type === 'user'
    ? `https://www.reddit.com/user/${encodeURIComponent(source)}/submitted/${encodeURIComponent(sort)}.json?limit=${Math.min(limit, 100)}&raw_json=1`
    : `https://www.reddit.com/r/${encodeURIComponent(source)}/${encodeURIComponent(sort)}.json?limit=${Math.min(limit, 100)}&raw_json=1`;

  const result = await fetchRedditPublicJson(url, {
    endpointKind: type === 'user' ? 'reddit_user' : 'subreddit',
    timeoutMs: config.HTTP_TIMEOUT_MS,
    transport,
  });
  const posts = parseRedditPublicJsonPosts(result.payload);
  const first = posts[0]
    ? {
        id: posts[0].id,
        title: posts[0].title.slice(0, 120),
        author: posts[0].author,
        subreddit: posts[0].subreddit,
      }
    : null;

  console.log(JSON.stringify({
    transport: result.transport,
    runtime: result.runtime,
    status: result.status,
    postsFetched: posts.length,
    first,
  }, null, 2));
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  const context = typeof error === 'object' && error && 'context' in error
    ? (error as { context?: unknown }).context
    : undefined;
  console.error(JSON.stringify({
    error: message,
    context,
  }, null, 2));
  process.exit(1);
});
