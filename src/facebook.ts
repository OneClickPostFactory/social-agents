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

interface FacebookGroupResponse extends GraphErrorResponse {
  id?: string;
  name?: string;
}

export async function verifyCredentials(): Promise<{ accountId: string; name?: string }> {
  const groupId = config.FACEBOOK_GROUP_ID;
  const token = config.META_ACCESS_TOKEN;
  if (!groupId || !token) {
    throw new Error('FACEBOOK_GROUP_ID or META_ACCESS_TOKEN not set');
  }
  const { data } = await requestJson<FacebookGroupResponse>(
    `https://graph.facebook.com/${config.META_GRAPH_VERSION}/${encodeURIComponent(groupId)}?fields=id,name`,
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      timeoutMs: config.HTTP_TIMEOUT_MS,
    }
  );
  if (data.error || !data.id) {
    throw new Error('Facebook API: ' + (data.error?.message || 'Authenticated Group lookup returned no id'));
  }
  return { accountId: data.id, name: data.name };
}

export async function verifyPublished(postId: string): Promise<{
  confirmed: boolean;
  providerResultId: string;
}> {
  const token = config.META_ACCESS_TOKEN;
  if (!token) {
    throw new Error('META_ACCESS_TOKEN not set');
  }
  const { data } = await requestJson<GraphErrorResponse & GraphSuccess>(
    `https://graph.facebook.com/${config.META_GRAPH_VERSION}/${encodeURIComponent(postId)}?fields=id`,
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      timeoutMs: config.HTTP_TIMEOUT_MS,
    }
  );
  if (data.error || !data.id) {
    throw new Error('Facebook API: ' + (data.error?.message || 'Published post lookup returned no id'));
  }
  return { confirmed: data.id === postId, providerResultId: data.id };
}

export function publish(message: string): Promise<string> {
  const groupId = config.FACEBOOK_GROUP_ID;
  const token = config.META_ACCESS_TOKEN;
  const version = config.META_GRAPH_VERSION;

  if (!groupId || !token) {
    throw new Error('FACEBOOK_GROUP_ID or META_ACCESS_TOKEN not set');
  }

  const body = JSON.stringify({ message });
  return requestJson<GraphErrorResponse & GraphSuccess>(`https://graph.facebook.com/${version}/${groupId}/feed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body,
    timeoutMs: config.HTTP_TIMEOUT_MS,
  }).then(({ data }) => {
    if (data.error) {
      throw new Error('Facebook API: ' + (data.error.message || 'Unknown error'));
    }
    return data.id;
  });
}
