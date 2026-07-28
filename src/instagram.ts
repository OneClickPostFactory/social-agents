import config from '../config';
import { requestJson } from './http-client';
import { assertCanonicalMetaPublicationPath } from './meta-publication-boundary';

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

interface InstagramAccountResponse extends GraphErrorResponse {
  id?: string;
  username?: string;
  name?: string;
}

interface InstagramMediaResponse extends GraphErrorResponse {
  id?: string;
  permalink?: string;
}

export async function verifyCredentials(): Promise<{
  accountId: string;
  username?: string;
  name?: string;
}> {
  const accountId = await resolveInstagramAccountId();
  const token = await resolveInstagramAccessToken();
  const account = await apiGet<InstagramAccountResponse>(
    `/${config.META_GRAPH_VERSION}/${accountId}?fields=id,username,name`,
    token
  );
  if (account.error || !account.id) {
    throw new Error('Instagram API: ' + (account.error?.message || 'Authenticated account lookup returned no id'));
  }
  return {
    accountId: account.id,
    username: account.username,
    name: account.name,
  };
}

export async function verifyPublished(postId: string): Promise<{
  confirmed: boolean;
  providerResultId: string;
  permalink?: string;
}> {
  const token = await resolveInstagramAccessToken();
  const media = await apiGet<InstagramMediaResponse>(
    `/${config.META_GRAPH_VERSION}/${encodeURIComponent(postId)}?fields=id,permalink`,
    token
  );
  if (media.error || !media.id) {
    throw new Error('Instagram API: ' + (media.error?.message || 'Published media lookup returned no id'));
  }
  return {
    confirmed: media.id === postId,
    providerResultId: media.id,
    permalink: media.permalink,
  };
}

export async function publish(_caption: string, _imageUrl: string): Promise<string> {
  assertCanonicalMetaPublicationPath('instagram');
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
