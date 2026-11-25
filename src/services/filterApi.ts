import type {
  ApiSuccessResponse,
  CreateTitleRequest,
  FilterInterval,
  PublishTitleRequest,
  TitleFilterConfig,
} from '../types';
import { extractAmazonGti, isAmazonGti, normalizeGti } from '../utils/gti';
import { validateTitleFilterConfig } from '../utils/validateConfig';
import { getPrimeCatalog } from './primeCatalog';
import { logger } from '../utils/logger';

interface ProxyResponse {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

type ApiMethod = 'GET' | 'POST' | 'PUT';

export class ExtensionContextInvalidatedError extends Error {
  constructor(message = 'Extension was reloaded. Refresh this Prime Video tab.') {
    super(message);
    this.name = 'ExtensionContextInvalidatedError';
  }
}

export function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function isContextInvalidatedError(err: unknown): boolean {
  if (!isExtensionContextValid()) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /extension context invalidated/i.test(message);
}

/**
 * Ask the service worker to call the backend. Direct fetch from the content
 * script is blocked by Chrome when the page origin is public (primevideo.com)
 * and the target is loopback (localhost).
 */
async function requestJson<T>(
  path: string,
  method: ApiMethod = 'GET',
  body?: unknown
): Promise<T> {
  if (!isExtensionContextValid()) {
    throw new ExtensionContextInvalidatedError();
  }

  const messageType =
    method === 'POST' ? 'API_POST' : method === 'PUT' ? 'API_PUT' : 'API_GET';

  let result: ProxyResponse;

  try {
    result = (await chrome.runtime.sendMessage({
      type: messageType,
      path,
      body,
    })) as ProxyResponse;
  } catch (err) {
    if (isContextInvalidatedError(err)) {
      throw new ExtensionContextInvalidatedError();
    }
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

  const responseBody = result.body as
    | ApiSuccessResponse<T>
    | { success: false; message: string };

  if (
    !responseBody ||
    typeof responseBody !== 'object' ||
    !('success' in responseBody) ||
    !responseBody.success
  ) {
    const message =
      responseBody &&
      'message' in responseBody &&
      typeof responseBody.message === 'string'
        ? responseBody.message
        : 'Invalid API response';
    throw new Error(message);
  }

  return (responseBody as ApiSuccessResponse<T>).data;
}

async function getJson<T>(path: string): Promise<T> {
  return requestJson<T>(path, 'GET');
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

/** Resolve by query; returns null when nothing matches (404). */
export async function tryResolveFiltersByQuery(
  query: string
): Promise<TitleFilterConfig | null> {
  try {
    return await resolveFiltersByQuery(query);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no matching title|404|not found/i.test(message)) {
      return null;
    }
    throw err;
  }
}

export async function createTitleConfig(
  input: CreateTitleRequest
): Promise<TitleFilterConfig> {
  const data = await requestJson<TitleFilterConfig>('/filters', 'POST', input);
  if (!validateTitleFilterConfig(data)) {
    throw new Error('Created title failed validation');
  }
  return data;
}

export async function publishTitleFilters(
  titleId: string,
  input: PublishTitleRequest
): Promise<TitleFilterConfig> {
  const data = await requestJson<TitleFilterConfig>(
    `/filters/${encodeURIComponent(titleId)}`,
    'PUT',
    input
  );
  if (!validateTitleFilterConfig(data)) {
    throw new Error('Published filters failed validation');
  }
  return data;
}

/**
 * Ensure a backend title exists for this movie/episode, then append filters.
 * Identity is Amazon GTI only.
 */
export async function appendFiltersForTitle(options: {
  title: string;
  kind: 'movie' | 'show';
  episodeName?: string;
  gti: string;
  videoUrl?: string;
  filters: FilterInterval[];
}): Promise<TitleFilterConfig> {
  const { title, kind, episodeName, gti, filters } = options;
  const videoUrl = options.videoUrl || `gti://${gti}`;

  if (!/amzn1\.dv\.gti\./i.test(gti)) {
    throw new Error('Amazon GTI is required to save filters');
  }

  let config = await tryResolveFiltersByQuery(gti);

  if (!config) {
    config = await createTitleConfig({
      title,
      kind,
      episodeName: kind === 'show' ? episodeName : undefined,
      gti,
      videoUrl,
      provider: 'prime-video',
      matchPatterns: [gti],
    });
  }

  const mergedPatterns = [
    ...new Set(
      [...config.matchPatterns, gti].filter((p) => /amzn1\.dv\.gti\./i.test(p))
    ),
  ];

  const merged = [...config.filters, ...filters];
  return publishTitleFilters(config.titleId, {
    title,
    kind,
    episodeName: kind === 'show' ? episodeName : undefined,
    gti,
    videoUrl,
    matchPatterns: mergedPatterns,
    filters: merged,
  });
}

function readText(selector: string): string {
  return document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

/**
 * High-signal text: URL, document title, metas, player labels, selected rows.
 * Does NOT include full page body (that is added separately for episode search).
 */
export function collectPriorityMatchText(
  pageUrl: string = location.href,
  pageTitle: string = document.title
): string {
  const parts: string[] = [pageUrl, pageTitle];

  for (const selector of [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[property="og:description"]',
  ]) {
    const content = document
      .querySelector(selector)
      ?.getAttribute('content')
      ?.trim();
    if (content) parts.push(content);
  }

  for (const selector of [
    '.atvwebplayersdk-title-text',
    '.atvwebplayersdk-subtitle-text',
    '.atvwebplayersdk-infobar-container',
    '[data-automation-id="title"]',
    '[data-automation-id="subtitle"]',
    '[data-automation-id="player-overlay-title"]',
    '[data-automation-id="player-overlay-subtitle"]',
    'h1',
  ]) {
    const text = readText(selector);
    if (text) parts.push(text);
  }

  // Currently selected / focused episode row on detail+player pages
  for (const selector of [
    '[aria-current="true"]',
    '[aria-selected="true"]',
    '[class*="selected" i]',
  ]) {
    Array.from(document.querySelectorAll(selector)).forEach((el) => {
      const text = el.textContent?.replace(/\s+/g, ' ').trim();
      if (text && text.length < 300) parts.push(text);
    });
  }

  return parts.join('\n');
}

/**
 * Full match corpus: priority UI text + page body.
 * Your console proved episode names can exist only in body.innerText.
 */
export function collectPageMatchText(
  pageUrl: string = location.href,
  pageTitle: string = document.title
): string {
  const priority = collectPriorityMatchText(pageUrl, pageTitle);
  const body = document.body?.innerText?.replace(/\s+/g, ' ').trim() || '';
  return `${priority}\n${body}`;
}

export interface MatchCandidateDebug {
  titleId: string;
  title: string;
  kind?: string;
  episodeName?: string;
  score: number;
  matchedPatterns: string[];
  reasons: string[];
}

function matchedPatternsFor(
  config: TitleFilterConfig,
  haystack: string
): string[] {
  return config.matchPatterns.filter((pattern) =>
    haystack.includes(pattern.toLowerCase())
  );
}

/** True when an episode name sits on a selected/active episode row in the DOM. */
function episodeAppearsSelected(episodeName: string): boolean {
  const episode = episodeName.trim().toLowerCase();
  if (!episode) return false;

  const nodes = Array.from(
    document.querySelectorAll(
      'a, li, article, button, [role="listitem"], [role="option"], [role="row"]'
    )
  );

  for (const node of nodes) {
    const text = node.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() || '';
    if (!text.includes(episode) || text.length > 400) continue;

    const className =
      typeof (node as HTMLElement).className === 'string'
        ? (node as HTMLElement).className
        : '';

    const selected =
      node.getAttribute('aria-current') === 'true' ||
      node.getAttribute('aria-selected') === 'true' ||
      /\b(selected|active|playing|current)\b/i.test(className) ||
      Boolean(
        node.querySelector(
          '[aria-current="true"], [aria-selected="true"], [class*="selected" i]'
        )
      );

    if (selected) return true;
  }

  return false;
}

function configIdentityGti(config: TitleFilterConfig): string | undefined {
  if (config.gti && isAmazonGti(config.gti)) return config.gti;
  for (const pattern of config.matchPatterns) {
    const gti = extractAmazonGti(pattern);
    if (gti) return gti;
  }
  return undefined;
}

function explainGtiScore(
  config: TitleFilterConfig,
  liveGtis: Set<string>,
  playingGti?: string
): MatchCandidateDebug {
  const gti = configIdentityGti(config);
  if (!gti) {
    return {
      titleId: config.titleId,
      title: config.title,
      kind: config.kind,
      episodeName: config.episodeName,
      score: 0,
      matchedPatterns: [],
      reasons: ['no Amazon GTI on config'],
    };
  }

  const key = normalizeGti(gti);
  if (!liveGtis.has(key)) {
    return {
      titleId: config.titleId,
      title: config.title,
      kind: config.kind,
      episodeName: config.episodeName,
      score: 0,
      matchedPatterns: [],
      reasons: [`GTI ${gti} not in live catalog`],
    };
  }

  const exactPlaying = playingGti && normalizeGti(playingGti) === key;
  return {
    titleId: config.titleId,
    title: config.title,
    kind: config.kind,
    episodeName: config.episodeName,
    score: exactPlaying ? 5000 : 1000,
    matchedPatterns: [gti],
    reasons: [
      exactPlaying
        ? `exact playing GTI ${gti} (+5000)`
        : `catalog GTI ${gti} (+1000)`,
    ],
  };
}

/**
 * Match filters by Amazon GTI only (playing / catalog GTIs).
 */
export function matchTitleConfig(
  configs: TitleFilterConfig[],
  _pageUrl?: string,
  _pageTitle?: string,
  _pageText?: string
): TitleFilterConfig | undefined {
  const catalog = getPrimeCatalog();
  const liveGtis = new Set<string>();
  if (catalog.playingGti) liveGtis.add(normalizeGti(catalog.playingGti));
  if (catalog.focusEpisodeId) liveGtis.add(normalizeGti(catalog.focusEpisodeId));
  if (catalog.parentGti) liveGtis.add(normalizeGti(catalog.parentGti));
  for (const g of catalog.gtis) liveGtis.add(normalizeGti(g));
  for (const ep of catalog.episodes) liveGtis.add(normalizeGti(ep.titleId));

  const evaluated = configs.map((config) =>
    explainGtiScore(config, liveGtis, catalog.playingGti)
  );
  const ranked = evaluated
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    logger.warn('Title match: no GTI candidates', {
      liveGtis: [...liveGtis],
      playingGti: catalog.playingGti,
      rejected: evaluated.map((row) => ({
        titleId: row.titleId,
        episodeName: row.episodeName,
        reasons: row.reasons,
      })),
    });
    return undefined;
  }

  const best = ranked[0];
  const winnerConfig = configs.find((c) => c.titleId === best.titleId);

  logger.info('Title match decision (GTI-only)', {
    winner: {
      titleId: best.titleId,
      title: best.title,
      kind: best.kind,
      episodeName: best.episodeName,
      score: best.score,
      matchedPatterns: best.matchedPatterns,
      reasons: best.reasons,
    },
    liveGtis: [...liveGtis],
    playingGti: catalog.playingGti,
  });

  return winnerConfig;
}
