import type { TitleFilterConfig } from '../types';
import { extractAmazonGti, isAmazonGti, normalizeGti } from '../utils/gti';
import { getPrimeCatalog } from './primeCatalog';
import { logger } from '../utils/logger';

export interface SeriesMatchResult {
  seriesKey: string;
  seriesLabel: string;
  reasons: string[];
  candidates: TitleFilterConfig[];
}

function displayLabel(config: TitleFilterConfig): string {
  if (config.kind === 'show' && config.episodeName?.trim()) {
    return `${config.title} — ${config.episodeName.trim()}`;
  }
  return config.title;
}

function configGti(config: TitleFilterConfig): string | undefined {
  if (config.gti && isAmazonGti(config.gti)) return config.gti;
  for (const pattern of config.matchPatterns) {
    const gti = extractAmazonGti(pattern);
    if (gti) return gti;
  }
  return undefined;
}

/**
 * Match filter configs by Amazon GTI only (playing episode/movie GTI,
 * parent season GTI, or any GTI present in the live catalog).
 */
export function findSeriesCandidates(
  configs: TitleFilterConfig[],
  _pageUrl?: string,
  _pageTitle?: string
): SeriesMatchResult | null {
  const catalog = getPrimeCatalog();
  const liveGtis = new Set<string>();

  if (catalog.playingGti) liveGtis.add(normalizeGti(catalog.playingGti));
  if (catalog.focusEpisodeId) liveGtis.add(normalizeGti(catalog.focusEpisodeId));
  if (catalog.parentGti) liveGtis.add(normalizeGti(catalog.parentGti));
  for (const g of catalog.gtis) liveGtis.add(normalizeGti(g));
  for (const ep of catalog.episodes) liveGtis.add(normalizeGti(ep.titleId));

  logger.info('Series detect input (GTI-only)', {
    liveGtis: [...liveGtis],
    contentKind: catalog.contentKind,
  });

  if (liveGtis.size === 0) return null;

  type Group = {
    seriesKey: string;
    seriesLabel: string;
    reasons: string[];
    candidates: TitleFilterConfig[];
    score: number;
  };

  const groups = new Map<string, Group>();

  for (const config of configs) {
    const gti = configGti(config);
    if (!gti) continue;
    const key = normalizeGti(gti);
    if (!liveGtis.has(key)) continue;

    const isShow = config.kind === 'show';
    const seriesKey = isShow
      ? `show:${normalizeGti(catalog.parentGti || config.title)}`
      : `movie:${key}`;
    const seriesLabel = config.title;

    let group = groups.get(seriesKey);
    if (!group) {
      group = {
        seriesKey,
        seriesLabel,
        reasons: [],
        candidates: [],
        score: 0,
      };
      groups.set(seriesKey, group);
    }

    const exactPlaying =
      catalog.playingGti &&
      normalizeGti(catalog.playingGti) === key;
    group.score += exactPlaying ? 200 : 100;
    group.reasons.push(
      exactPlaying ? `playing GTI ${gti}` : `catalog GTI ${gti}`
    );
    if (!group.candidates.some((c) => c.titleId === config.titleId)) {
      group.candidates.push(config);
    }
  }

  const ranked = [...groups.values()].sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return null;

  const best = ranked[0];
  best.candidates.sort((a, b) =>
    displayLabel(a).toLowerCase().localeCompare(displayLabel(b).toLowerCase())
  );

  logger.info('Series candidates (GTI-only)', {
    seriesKey: best.seriesKey,
    seriesLabel: best.seriesLabel,
    reasons: best.reasons,
    candidateIds: best.candidates.map((c) => c.titleId),
    gtis: best.candidates.map((c) => configGti(c)),
  });

  return {
    seriesKey: best.seriesKey,
    seriesLabel: best.seriesLabel,
    reasons: best.reasons,
    candidates: best.candidates,
  };
}

export function formatCandidateLabel(config: TitleFilterConfig): string {
  return displayLabel(config);
}
