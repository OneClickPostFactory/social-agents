import config from '../config';
import { requestJson } from './http-client';

interface GraphSuccess {
  id: string;
}

interface GraphErrorResponse {
  error?: {
    message?: string;
  };
  id?: string;
}

interface PageDetailsResponse extends GraphErrorResponse {
  access_token?: string;
  instagram_business_account?: {
    id?: string;
  };
}

export async function publish(caption: string, imageUrl: string): Promise<string> {
  const version = config.META_GRAPH_VERSION;

  const accountId = await resolveInstagramAccountId();
  const token = await resolveInstagramAccessToken();

  if (!imageUrl) {
    throw new Error('imageUrl is required for Instagram posts');
  }

  const containerId = await apiPost(`/${version}/${accountId}/media`, {
    caption,
    image_url: imageUrl,
  }, token);

  await sleep(3000);

  return apiPost(`/${version}/${accountId}/media_publish`, {
    creation_id: containerId,
  }, token);
}

async function resolveInstagramAccountId(): Promise<string> {
  if (config.INSTAGRAM_ACCOUNT_ID) {
    return config.INSTAGRAM_ACCOUNT_ID;
  }

  const pageId = config.FACEBOOK_PAGE_ID;
  const token = config.META_ACCESS_TOKEN;
  const version = config.META_GRAPH_VERSION;

  if (!pageId || !token) {
    throw new Error('INSTAGRAM_ACCOUNT_ID not set and cannot be auto-discovered without FACEBOOK_PAGE_ID + META_ACCESS_TOKEN');
  }

  const page = await apiGet<PageDetailsResponse>(
    `/${version}/${pageId}?fields=instagram_business_account{id}`,
    token
  );

  if (page.error) {
    throw new Error('Instagram API: ' + (page.error.message || 'Failed to inspect Page for instagram_business_account'));
  }

  const accountId = page.instagram_business_account?.id;
  if (!accountId) {
    throw new Error('Instagram API: No instagram_business_account is linked to FACEBOOK_PAGE_ID yet');
  }

  return accountId;
}

async function resolveInstagramAccessToken(): Promise<string> {
  if (config.FACEBOOK_PAGE_ACCESS_TOKEN) {
    return config.FACEBOOK_PAGE_ACCESS_TOKEN;
  }

  const pageId = config.FACEBOOK_PAGE_ID;
  const token = config.META_ACCESS_TOKEN;
  const version = config.META_GRAPH_VERSION;

  if (!pageId || !token) {
    throw new Error('FACEBOOK_PAGE_ACCESS_TOKEN not set and cannot be auto-discovered without FACEBOOK_PAGE_ID + META_ACCESS_TOKEN');
  }

  const page = await apiGet<PageDetailsResponse>(
    `/${version}/${pageId}?fields=access_token`,
    token
  );

  if (page.error) {
    throw new Error('Instagram API: ' + (page.error.message || 'Failed to inspect Page for access_token'));
  }

  if (!page.access_token) {
    throw new Error('Instagram API: Could not retrieve a Facebook Page access token for Instagram publishing');
  }

  return page.access_token;
}

function apiGet<T extends GraphErrorResponse>(pathname: string, token: string): Promise<T> {
  return requestJson<T>(`https://graph.facebook.com${pathname}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    timeoutMs: config.HTTP_TIMEOUT_MS,
  }).then(({ data }) => data);
}

function apiPost(pathname: string, params: Record<string, string>, token: string): Promise<string> {
  const body = JSON.stringify(params);
  return requestJson<GraphErrorResponse & GraphSuccess>(`https://graph.facebook.com${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body,
    timeoutMs: config.HTTP_TIMEOUT_MS,
  }).then(({ data }) => {
    if (data.error) {
      throw new Error('Instagram API: ' + (data.error.message || 'Unknown error'));
    }
    return data.id;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
