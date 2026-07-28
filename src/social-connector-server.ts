import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import config from '../config';
import {
  executeSocialConnectorAction,
  getSocialConnectorLedger,
  getSocialConnectorStatus,
  recordRelaySocialAction,
  verifySocialConnectorAction,
} from './social-connector';
import { isHttpError } from './errors';
import * as logger from './logger';

const MAX_BODY_BYTES = 64 * 1024;

let connectorServer: http.Server | undefined;
let activeSocketPath: string | undefined;

export function getSocialConnectorSocketPath(): string {
  return path.resolve(
    process.env.SOCIAL_CONNECTOR_SOCKET_PATH
      || path.join(config.APP_DATA_DIR, 'social-connector.sock')
  );
}

function safeErrorResponse(error: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  if (isHttpError(error)) {
    return {
      status: error.status,
      body: {
        error: error.expose ? error.message : 'Connector request failed',
        code: error.code || 'CONNECTOR_REQUEST_FAILED',
      },
    };
  }
  return {
    status: 500,
    body: {
      error: 'Connector request failed',
      code: 'CONNECTOR_INTERNAL_ERROR',
    },
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new Error('connector_request_too_large');
    }
  }
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

export async function handleSocialConnectorRequest(
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  switch (payload.operation) {
    case 'status':
      return { ...await getSocialConnectorStatus({ verifyAuth: payload.verifyAuth === true }) };
    case 'execute':
      return executeSocialConnectorAction(payload.request as never);
    case 'verify':
      return verifySocialConnectorAction(payload.request as never);
    case 'ledger':
      if (payload.mode === 'list') {
        return {
          connector: 'social-agent',
          actions: getSocialConnectorLedger(
            String(payload.liveSessionId || ''),
            Number(payload.limit || 100)
          ),
        };
      }
      return recordRelaySocialAction(payload.request as never);
    default:
      return {
        connector: 'social-agent',
        error: 'Unsupported connector operation',
        code: 'UNSUPPORTED_CONNECTOR_OPERATION',
      };
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/v1/social-connector') {
    sendJson(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    return;
  }
  try {
    const result = await handleSocialConnectorRequest(await readBody(req));
    sendJson(res, 200, result);
  } catch (error) {
    const response = safeErrorResponse(error);
    logger.warn('Social connector request failed', {
      code: response.body.code,
    });
    sendJson(res, response.status, response.body);
  }
}

export function startSocialConnectorServer(
  socketPath = getSocialConnectorSocketPath()
): http.Server {
  if (connectorServer) return connectorServer;

  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  connectorServer = http.createServer((req, res) => {
    void handleRequest(req, res);
  });
  activeSocketPath = socketPath;
  connectorServer.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    logger.info(`Social connector ready on private socket ${socketPath}`);
  });
  return connectorServer;
}

export async function stopSocialConnectorServer(): Promise<void> {
  if (!connectorServer) return;
  const server = connectorServer;
  connectorServer = undefined;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  if (activeSocketPath && fs.existsSync(activeSocketPath)) {
    fs.unlinkSync(activeSocketPath);
  }
  activeSocketPath = undefined;
}
