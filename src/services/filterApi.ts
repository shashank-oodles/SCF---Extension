import type { ApiSuccessResponse, TitleFilterConfig } from '../types';
import { validateTitleFilterConfig } from '../utils/validateConfig';
import { logger } from '../utils/logger';

interface ProxyResponse {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

/**
 * Ask the service worker to call the backend. Direct fetch from the content
 * script is blocked by Chrome when the page origin is public (primevideo.com)
 * and the target is loopback (localhost).
 */
async function getJson<T>(path: string): Promise<T> {
  let result: ProxyResponse;

  try {
    result = (await chrome.runtime.sendMessage({
      type: 'API_GET',
      path,
    })) as ProxyResponse;
  } catch (err) {
    logger.error('Service worker message failed', path, err);
    throw new Error(
      'Extension background unavailable. Reload the extension on chrome://extensions/'
    );
  }

  if (!result) {
    throw new Error(
      'No response from extension background. Reload the SCF extension.'
    );
  }

  if (!result.ok) {
    const message =
      result.error ||
      (result.body &&
      typeof result.body === 'object' &&
      'message' in result.body &&
      typeof (result.body as { message: unknown }).message === 'string'
        ? (result.body as { message: string }).message
        : `Request failed (${result.status})`);
    logger.error('API request failed', path, message);
    throw new Error(
      result.status === 0
        ? `Backend unreachable at localhost:3001. Is it running? (${message})`
        : message
    );
  }

  const body = result.body as
    | ApiSuccessResponse<T>
    | { success: false; message: string };

  if (!body || typeof body !== 'object' || !('success' in body) || !body.success) {
    const message =
      body && 'message' in body && typeof body.message === 'string'
        ? body.message
        : 'Invalid API response';
    throw new Error(message);
  }

  return (body as ApiSuccessResponse<T>).data;
}

export async function fetchAllTitleConfigs(): Promise<TitleFilterConfig[]> {
  const data = await getJson<TitleFilterConfig[]>('/filters');
  return data.filter(validateTitleFilterConfig);
}

export async function fetchFiltersByTitleId(
  titleId: string
): Promise<TitleFilterConfig> {
  const data = await getJson<TitleFilterConfig>(
    `/filters/${encodeURIComponent(titleId)}`
  );

  if (!validateTitleFilterConfig(data)) {
    throw new Error('Received invalid filter configuration from backend');
  }

  return data;
}

export async function resolveFiltersByQuery(
  query: string
): Promise<TitleFilterConfig> {
  const data = await getJson<TitleFilterConfig>(
    `/filters/resolve?q=${encodeURIComponent(query)}`
  );

  if (!validateTitleFilterConfig(data)) {
    throw new Error('Received invalid filter configuration from backend');
  }

  return data;
}

/**
 * Match page context against known title configs (local match first to avoid
 * unnecessary resolve calls when the title list is already cached).
 */
export function matchTitleConfig(
  configs: TitleFilterConfig[],
  pageUrl: string,
  pageTitle: string
): TitleFilterConfig | undefined {
  const haystack = `${pageUrl}\n${pageTitle}`.toLowerCase();

  return configs.find((config) =>
    config.matchPatterns.some((pattern) =>
      haystack.includes(pattern.toLowerCase())
    )
  );
}
