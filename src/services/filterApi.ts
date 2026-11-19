import type { ApiSuccessResponse, TitleFilterConfig } from '../types';
import { validateTitleFilterConfig } from '../utils/validateConfig';
import { logger } from '../utils/logger';

interface ProxyResponse {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

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
async function getJson<T>(path: string): Promise<T> {
  if (!isExtensionContextValid()) {
    throw new ExtensionContextInvalidatedError();
  }

  let result: ProxyResponse;

  try {
    result = (await chrome.runtime.sendMessage({
      type: 'API_GET',
      path,
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

function explainScore(
  config: TitleFilterConfig,
  priority: string,
  haystack: string
): MatchCandidateDebug {
  const matchedPatterns = matchedPatternsFor(config, haystack);
  const reasons: string[] = [];
  let score = 0;

  if (matchedPatterns.length === 0) {
    return {
      titleId: config.titleId,
      title: config.title,
      kind: config.kind,
      episodeName: config.episodeName,
      score: 0,
      matchedPatterns: [],
      reasons: ['no matchPatterns found in page text/url'],
    };
  }

  if (config.kind === 'show' && config.episodeName?.trim()) {
    const episode = config.episodeName.trim().toLowerCase();
    const inBody = haystack.includes(episode);
    const inPriority = priority.includes(episode);
    const selected = episodeAppearsSelected(config.episodeName);

    if (!inBody) {
      return {
        titleId: config.titleId,
        title: config.title,
        kind: config.kind,
        episodeName: config.episodeName,
        score: 0,
        matchedPatterns,
        reasons: [
          `episodeName "${config.episodeName}" not found on page`,
          `patterns that did hit: ${matchedPatterns.join(' | ')}`,
        ],
      };
    }

    score = 10;
    reasons.push('episodeName found on page (+10)');
    reasons.push(`patterns hit: ${matchedPatterns.join(' | ')}`);

    if (selected) {
      score += 2000;
      reasons.push('episode appears on a selected/active row (+2000)');
    }
    if (inPriority) {
      score += 1000;
      reasons.push('episodeName found in priority UI/title/url (+1000)');
    } else {
      reasons.push('episodeName only in page body (not in player/title UI)');
    }

    const tie = Math.min(episode.length, 40) / 100;
    score += tie;
    reasons.push(`episode name length tie-break (+${tie.toFixed(2)})`);

    return {
      titleId: config.titleId,
      title: config.title,
      kind: config.kind,
      episodeName: config.episodeName,
      score,
      matchedPatterns,
      reasons,
    };
  }

  score = 20;
  reasons.push(`patterns hit: ${matchedPatterns.join(' | ')} (+20)`);
  if (matchedPatternsFor(config, priority).length > 0) {
    score += 100;
    reasons.push('pattern also in priority UI/title/url (+100)');
  }

  return {
    titleId: config.titleId,
    title: config.title,
    kind: config.kind,
    episodeName: config.episodeName,
    score,
    matchedPatterns,
    reasons,
  };
}

/**
 * Movies: any matchPattern substring hit is enough.
 * Shows: episodeName must appear somewhere on the page (including body text),
 * plus at least one matchPattern. When several episodes of the same show are
 * listed on the page, prefer the one also present in priority/selected UI text.
 */
export function matchTitleConfig(
  configs: TitleFilterConfig[],
  pageUrl: string,
  pageTitle: string,
  pageText?: string
): TitleFilterConfig | undefined {
  const priority = collectPriorityMatchText(pageUrl, pageTitle).toLowerCase();
  const haystack = (pageText ?? collectPageMatchText(pageUrl, pageTitle)).toLowerCase();

  const evaluated = configs.map((config) => explainScore(config, priority, haystack));
  const ranked = evaluated
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    logger.warn('Title match: no candidates', {
      href: pageUrl,
      documentTitle: pageTitle,
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

  logger.info('Title match decision', {
    winner: {
      titleId: best.titleId,
      title: best.title,
      kind: best.kind,
      episodeName: best.episodeName,
      score: best.score,
      matchedPatterns: best.matchedPatterns,
      reasons: best.reasons,
    },
    allCandidates: ranked.map((row) => ({
      titleId: row.titleId,
      episodeName: row.episodeName,
      score: Number(row.score.toFixed(2)),
      matchedPatterns: row.matchedPatterns,
      reasons: row.reasons,
    })),
    page: {
      href: pageUrl,
      documentTitle: pageTitle,
      priorityPreview: priority.slice(0, 240),
    },
  });

  if (ranked.length > 1 && ranked[1].score >= best.score - 0.5) {
    logger.warn('Title match is close / possibly wrong', {
      winnerId: best.titleId,
      runnerUpId: ranked[1].titleId,
      winnerScore: best.score,
      runnerUpScore: ranked[1].score,
    });
  }

  return winnerConfig;
}
