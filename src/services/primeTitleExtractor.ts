import { logger } from '../utils/logger';
import {
  activeCatalogEpisode,
  getPrimeCatalog,
} from './primeCatalog';

export type PrimeKind = 'movie' | 'show' | 'unknown';

export interface PrimeEpisode {
  name: string;
  /** Optional season/episode label if found nearby, e.g. "S1 E4" */
  label?: string;
  /** Amazon GTI when known from player catalog APIs */
  titleId?: string;
  nowPlaying?: boolean;
}

export interface PrimePageInfo {
  kind: PrimeKind;
  /** Main title extracted from Prime (movie or show name) */
  title: string;
  /** Current episode title when available (shows) */
  episodeName?: string;
  /** e.g. "Season 1" */
  seasonLabel?: string;
  /** Playing entity GTI (movie or episode) — primary identity */
  gti?: string;
  parentGti?: string;
  pageUrl: string;
  documentTitle: string;
  /** Episodes scraped from the show page list / player catalog */
  episodes: PrimeEpisode[];
  /** Debug: where fields came from */
  sources: string[];
}

function clean(text: string | null | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function readText(selector: string): string {
  return clean(document.querySelector(selector)?.textContent);
}

function readMeta(selector: string): string {
  return clean(document.querySelector(selector)?.getAttribute('content'));
}

function stripPrimeSuffix(title: string): string {
  return title
    .replace(/^prime video:\s*/i, '')
    .replace(/\s*\|\s*prime video.*$/i, '')
    .replace(/\s*[-–—]\s*prime video.*$/i, '')
    .replace(/\s+on\s+prime video.*$/i, '')
    .trim();
}

function parseDocumentTitle(docTitle: string): {
  title?: string;
  kind: PrimeKind;
  seasonLabel?: string;
  episodeName?: string;
} {
  const raw = stripPrimeSuffix(clean(docTitle));
  if (!raw) return { kind: 'unknown' };

  // "FROM (TV) - Season 1"
  const tvSeason = raw.match(/^(.*?)\s*\((TV|Series)\)\s*[-–—]\s*(Season\s+\d+.*)$/i);
  if (tvSeason) {
    return {
      title: clean(tvSeason[1]),
      kind: 'show',
      seasonLabel: clean(tvSeason[3]),
    };
  }

  // "Show Name - Season 1"
  const seasonOnly = raw.match(/^(.*?)\s*[-–—]\s*(Season\s+\d+.*)$/i);
  if (seasonOnly && /season\s+\d+/i.test(seasonOnly[2])) {
    return {
      title: clean(seasonOnly[1]),
      kind: 'show',
      seasonLabel: clean(seasonOnly[2]),
    };
  }

  // "S1 E3 Episode Name" / "Season 1, Ep. 3 Episode Name"
  const epInline = raw.match(
    /^(.*?)\s*[-–—:]\s*(?:S(?:eason)?\s*\d+\s*[,.]?\s*E(?:p(?:isode)?)?\s*\d+\s*)(.+)$/i
  );
  if (epInline) {
    return {
      title: clean(epInline[1]),
      kind: 'show',
      episodeName: clean(epInline[2]),
    };
  }

  // "(TV)" anywhere → show
  if (/\(TV\)|\(Series\)/i.test(raw)) {
    return {
      title: clean(raw.replace(/\s*\((TV|Series)\)/gi, '')),
      kind: 'show',
    };
  }

  // "(Movie)" or plain title → movie guess when not TV-ish
  if (/\(Movie\)/i.test(raw)) {
    return {
      title: clean(raw.replace(/\s*\(Movie\)/gi, '')),
      kind: 'movie',
    };
  }

  return { title: raw, kind: 'unknown' };
}

/** Strip Prime UI chrome that gets concatenated into episode row text. */
function stripUiNoise(text: string): string {
  return clean(
    text
      .replace(/(?:Play)+/gi, ' ')
      .replace(/Downloads?/gi, ' ')
      .replace(/Watchlist|Share|Trailer|Bonus/gi, ' ')
      .replace(/Subtitles?\s*Cc?/gi, ' ')
      .replace(/\bCc\b/gi, ' ')
      .replace(/\d+\s*min(?:utes?)?(?:\s*left)?/gi, ' ')
      .replace(
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s*\d{4}\b/gi,
        ' '
      )
      .replace(/\bIMDb\b.*$/i, ' ')
  );
}

function isNoiseEpisodeName(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  if (n.length < 2 || n.length > 100) return true;
  if (
    /^(downloads?|play|watch|trailer|bonus|episodes?|season\s*\d*|subtitles?|cc|\d+\s*min(?:utes?)?|resume)$/i.test(
      n
    )
  ) {
    return true;
  }
  // Reject if still mostly UI verbs
  if (/(play|download|subtitle)/i.test(n) && !/^\d+\.\s+/.test(n)) return true;
  return false;
}

/**
 * Prime episode rows look like "1. The Peace Problem".
 * Only accept numbered titles; ignore Play/Downloads/duration chrome.
 */
function scrapeEpisodesFromPage(showTitle?: string): PrimeEpisode[] {
  const byNumber = new Map<number, PrimeEpisode>();

  const showSuffix = showTitle
    ? new RegExp(
        `\\s*[-–—|]\\s*${showTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
        'i'
      )
    : null;

  const consider = (raw: string) => {
    const cleaned = stripUiNoise(raw);
    if (!cleaned) return;

    // Require Prime's numbered episode pattern: "1. Title"
    const matches = cleaned.matchAll(/(\d{1,3})\.\s+([A-Za-z0-9].{0,80}?)(?=\s+\d{1,3}\.\s+|$)/g);
    for (const match of matches) {
      const num = Number(match[1]);
      if (!Number.isFinite(num) || num < 1 || num > 100) continue;

      let name = clean(match[2]);
      if (showSuffix) name = clean(name.replace(showSuffix, ''));
      // Drop trailing junk after a real title
      name = clean(name.replace(/\s{2,}.*$/, ''));

      const display = `${num}. ${name}`;
      if (isNoiseEpisodeName(name) || isNoiseEpisodeName(display)) continue;
      if (name.split(' ').length > 16) continue;

      // Prefer cleaner/shorter name if we already saw this number
      const existing = byNumber.get(num);
      if (!existing || display.length < existing.name.length) {
        byNumber.set(num, { name: display, label: `E${num}` });
      }
    }
  };

  // Narrow selectors only — never scan all li/a/span (Prime DOM is huge)
  const preferred = Array.from(
    document.querySelectorAll(
      [
        '[data-testid*="episode" i]',
        '[data-automation-id*="episode" i]',
        '[class*="episode" i]',
        '[class*="Episode" i]',
      ].join(',')
    )
  ).slice(0, 80);

  for (const el of preferred) {
    const text = clean(el.textContent);
    if (!text || text.length > 220) continue;
    if (!/\d{1,3}\.\s+[A-Za-z0-9]/.test(text)) continue;
    consider(text);
  }

  return [...byNumber.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ep]) => ep)
    .slice(0, 40);
}

/** Cheap show-page check: season picker or an "S1 E5"-style play/resume button. */
export function looksLikeShowDetailPage(): boolean {
  if (
    document.querySelector(
      '[data-testid*="season" i], [data-automation-id*="season" i], [aria-label*="season" i]'
    )
  ) {
    return true;
  }
  const playButtons = document.querySelectorAll(
    '[data-testid*="play" i], [data-automation-id*="play" i], [data-testid*="resume" i]'
  );
  for (const el of Array.from(playButtons).slice(0, 10)) {
    if (/\bS\d+\s*E\d+\b/i.test(el.textContent || '')) return true;
  }
  return false;
}

/**
 * Extract what Prime Video is currently showing — no backend matching.
 */
export function extractPrimePageInfo(
  pageUrl: string = location.href,
  documentTitle: string = document.title,
  playerOpen = false
): PrimePageInfo {
  const sources: string[] = [];

  // Prime leaves the closed player's DOM (with the last title) in the page.
  const playerTitle = playerOpen ? readText('.atvwebplayersdk-title-text') : '';
  const playerSubtitle = playerOpen
    ? readText('.atvwebplayersdk-subtitle-text')
    : '';
  const autoTitle = readText('[data-automation-id="title"]');
  const autoSubtitle = readText('[data-automation-id="subtitle"]');
  const h1 = readText('h1');
  const ogTitle = readMeta('meta[property="og:title"]');

  const parsedDoc = parseDocumentTitle(documentTitle);

  let title =
    playerTitle ||
    autoTitle ||
    h1 ||
    parsedDoc.title ||
    stripPrimeSuffix(ogTitle) ||
    '';
  let kind: PrimeKind = parsedDoc.kind;
  let episodeName =
    playerSubtitle ||
    autoSubtitle ||
    parsedDoc.episodeName ||
    undefined;
  let seasonLabel = parsedDoc.seasonLabel;

  if (playerTitle) sources.push('playerTitle');
  if (autoTitle) sources.push('automationTitle');
  if (h1 && !playerTitle && !autoTitle) sources.push('h1');
  if (parsedDoc.title) sources.push('documentTitle');
  if (playerSubtitle || autoSubtitle) sources.push('episodeSubtitle');

  // Player subtitle on shows is often "Season 1, Ep. 3 Episode Name"
  if (episodeName) {
    const subParse = episodeName.match(
      /(?:Season|Saison|Temporada|Staffel)\s+(\d+)\s*,?\s*Ep\.?\s*(\d+)\s*(.*)$/i
    ) || episodeName.match(/S(\d+)\s*E(\d+)\s*(.*)$/i);
    if (subParse) {
      seasonLabel = seasonLabel || `Season ${subParse[1]}`;
      const rest = clean(subParse[3]);
      if (rest) episodeName = rest;
      kind = 'show';
      sources.push('subtitleSeasonEp');
    }
  }

  // Clean show title if it still contains season junk
  title = stripPrimeSuffix(title).replace(/\s*\((TV|Series|Movie)\)/gi, '').trim();

  // Prefer network catalog — skip expensive DOM scrape when we already have GTIs
  const catalog = getPrimeCatalog();
  const hasCatalogIdentity = Boolean(
    catalog.playingGti ||
      catalog.focusEpisodeId ||
      catalog.movieTitle ||
      catalog.seriesTitle ||
      catalog.episodes.length > 0
  );

  const episodes: PrimeEpisode[] = [];
  if (!hasCatalogIdentity) {
    // DOM scrape is expensive on Prime (thousands of nodes). Only as fallback.
    const scraped = scrapeEpisodesFromPage(title);
    if (scraped.length >= 1) {
      kind = 'show';
      episodes.push(...scraped);
      sources.push(`domEpisodeList:${scraped.length}`);
    }
  }

  if (kind === 'unknown' && looksLikeShowDetailPage()) {
    kind = 'show';
    sources.push('domShowSignal');
  }

  // If still unknown and title looks like a feature film page with no season
  if (kind === 'unknown' && title && !seasonLabel && episodes.length === 0) {
    kind = 'movie';
    sources.push('defaultMovie');
  }

  // Prefer listing page episodes only — don't inject noisy player subtitle blobs
  if (kind === 'show' && episodeName) {
    const cleanedEp = stripUiNoise(episodeName);
    const numbered = cleanedEp.match(/^(\d{1,3})\.\s+(.+)$/);
    if (numbered && !isNoiseEpisodeName(numbered[2])) {
      episodeName = `${numbered[1]}. ${clean(numbered[2])}`;
    } else if (isNoiseEpisodeName(cleanedEp) || /play|download|min left/i.test(episodeName)) {
      episodeName = undefined;
    } else {
      episodeName = cleanedEp;
    }
  }

  // Enrich from:
  // 1) catalogMetadataV2 + playbackRestrictions (current movie/episode)
  // 2) episodeList (show episode carousel)
  // 3) Sonar titleId (player playing GTI)
  const active = activeCatalogEpisode();
  let gti = catalog.playingGti || catalog.focusEpisodeId || active?.titleId;
  let parentGti = catalog.parentGti || active?.parentId;

  if (catalog.contentKind === 'movie') {
    kind = 'movie';
    episodeName = undefined;
    seasonLabel = undefined;
    parentGti = undefined;
    episodes.splice(0, episodes.length);
    if (catalog.movieTitle?.trim()) {
      title = catalog.movieTitle.trim();
      sources.push('catalogMetadataV2');
    }
    if (gti) sources.push('playbackRestrictions|sonar');
  } else if (
    catalog.contentKind === 'show' ||
    catalog.seriesTitle ||
    catalog.episodeTitle ||
    catalog.episodes.length > 0
  ) {
    kind = 'show';

    if (catalog.seriesTitle?.trim()) {
      title = catalog.seriesTitle.trim();
      sources.push('catalogMetadataV2.seriesTitle');
    }

    if (catalog.seasonNumber != null) {
      seasonLabel = `Season ${catalog.seasonNumber}`;
      sources.push('catalogMetadataV2.season');
    }

    // Prefer catalogMetadataV2 episode fields for current/resume title
    if (catalog.episodeTitle?.trim()) {
      const se =
        catalog.seasonNumber != null && catalog.episodeNumber != null
          ? `S${catalog.seasonNumber} E${catalog.episodeNumber}`
          : active?.label || active?.cardTitle;
      episodeName = se
        ? `${se} · ${catalog.episodeTitle.trim()}`
        : catalog.episodeTitle.trim();
      sources.push('catalogMetadataV2.episode');
    } else if (active) {
      episodeName = active.name;
      sources.push('episodeList.nowPlaying');
    }

    if (catalog.episodes.length > 0) {
      const catalogEps: PrimeEpisode[] = catalog.episodes.map((ep) => ({
        name: ep.name,
        label: ep.label || ep.cardTitle,
        titleId: ep.titleId,
        nowPlaying: ep.nowPlaying,
      }));
      episodes.splice(0, episodes.length, ...catalogEps);
      sources.push(`episodeList:${catalog.episodes.length}`);
    }

    if (active?.titleId) {
      gti = active.titleId;
      parentGti = active.parentId || parentGti;
    } else if (catalog.playingGti) {
      gti = catalog.playingGti;
    }
  } else if (catalog.movieTitle?.trim() && catalog.episodes.length === 0) {
    kind = 'movie';
    title = catalog.movieTitle.trim();
    episodeName = undefined;
    sources.push('catalogMovieTitle');
  } else if (gti && catalog.episodes.length === 0) {
    if (kind === 'unknown') kind = 'movie';
    sources.push('sonar.titleId');
  }

  if (gti) sources.push(`gti:${gti}`);

  const info: PrimePageInfo = {
    kind,
    title: title || 'Unknown title',
    episodeName: kind === 'show' ? episodeName : undefined,
    seasonLabel: kind === 'show' ? seasonLabel : undefined,
    gti,
    parentGti: kind === 'show' ? parentGti : undefined,
    pageUrl,
    documentTitle,
    episodes: kind === 'show' ? episodes : [],
    sources,
  };

  logger.info('Extracted Prime page info', info);
  return info;
}
