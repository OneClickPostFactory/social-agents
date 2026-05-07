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
