import * as http from 'node:http';
import * as https from 'node:https';

import config from '../config';

import type { RedditPost } from './types';

interface RedditChild {
  data?: {
    id?: string;
    title?: string;
    selftext?: string;
    url?: string;
    score?: number;
    num_comments?: number;
    subreddit?: string;
    author?: string;
    created_utc?: number;
    stickied?: boolean;
    is_video?: boolean;
  };
}

interface RedditResponse {
  data?: {
    children?: RedditChild[];
  };
}

export async function fetchPosts(sort = 'new', limit = 50): Promise<RedditPost[]> {
  const user = config.REDDIT_USER.toLowerCase();
  const allowedSubs = config.REDDIT_ALLOWED_SUBS;

  if (!user) {
    throw new Error('REDDIT_USER is not set in .env');
  }

  if (!allowedSubs.size) {
    throw new Error('REDDIT_ALLOWED_SUBS is not set in .env');
  }

  const allPosts: RedditPost[] = [];

  for (const sub of allowedSubs) {
    try {
      const posts = await request(
        `https://www.reddit.com/r/${encodeURIComponent(sub)}/${sort}.json?limit=${limit}&raw_json=1`
      );
      allPosts.push(...posts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[reddit] Failed to fetch r/${sub}: ${message}`);
    }
  }

  const filtered = allPosts.filter(post => post.author.toLowerCase() === user);
  const seen = new Set<string>();

  return filtered
    .sort((a, b) => b.created - a.created)
    .filter(post => {
      if (seen.has(post.id)) return false;
      seen.add(post.id);
      return true;
    });
}

function request(url: string, redirects = 0): Promise<RedditPost[]> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    const lib = url.startsWith('https') ? https : http;

    const options: http.RequestOptions = {
      headers: {
        'User-Agent': `social-agent/1.0 linux content automation by ${config.REDDIT_USER}`,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    };

    lib.get(url, options, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://www.reddit.com${res.headers.location}`;
        res.resume();
        request(next, redirects + 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode === 404) {
        reject(new Error('Subreddit not found (404)'));
        return;
      }

      if (res.statusCode === 403) {
        reject(new Error('Reddit blocked request (403)'));
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Reddit HTTP ${res.statusCode}`));
        return;
      }

      let body = '';
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(body) as RedditResponse;
          const children = json.data?.children || [];
          const posts = children
            .map(child => child.data)
            .filter((post): post is NonNullable<RedditChild['data']> => Boolean(post && !post.stickied && !post.is_video))
            .map(post => ({
              id: post.id || '',
              title: post.title || '',
              selftext: post.selftext || '',
              url: post.url || '',
              score: post.score || 0,
              comments: post.num_comments || 0,
              subreddit: post.subreddit || '',
              author: post.author || '',
              created: post.created_utc || 0,
            }));
          resolve(posts);
        } catch (error) {
          reject(new Error('Failed to parse Reddit response: ' + String(error)));
        }
      });
    }).on('error', reject);
  });
}
