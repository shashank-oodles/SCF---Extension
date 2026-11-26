import { logger } from '../utils/logger';

export interface CatalogEpisode {
  titleId: string;
  parentId?: string;
  cardTitle?: string;
  cardSubtitle?: string;
  contentType?: string;
  nowPlaying?: boolean;
  name: string;
  label?: string;
}

export interface PrimeCatalogSnapshot {
  contentKind?: 'movie' | 'show';
  /** Current play/resume GTI (movie or episode) */
  playingGti?: string;
  focusEpisodeId?: string;
  parentGti?: string;
  seriesTitle?: string;
  movieTitle?: string;
  episodeTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodes: CatalogEpisode[];
  gtis: string[];
  pageKey?: string;
  api?: string;
  updatedAt: number;
}

const MESSAGE_SOURCE = 'SCF_PRIME_NETWORK';

function emptyCatalog(pageKey?: string): PrimeCatalogSnapshot {
  return { episodes: [], gtis: [], pageKey, updatedAt: Date.now() };
}

let catalog: PrimeCatalogSnapshot = emptyCatalog();
const listeners = new Set<() => void>();

function displayName(ep: {
  cardTitle?: string;
  cardSubtitle?: string;
  titleId: string;
}): { name: string; label?: string } {
  const title = (ep.cardTitle || '').trim();
  const subtitle = (ep.cardSubtitle || '').trim();
  if (title && subtitle) return { name: `${title} · ${subtitle}`, label: title };
  if (subtitle) return { name: subtitle, label: title || undefined };
  if (title) return { name: title };
  return { name: ep.titleId };
}

export function pageKeyFromUrl(href: string = location.href): string {
  try {
    const url = new URL(href, location.href);
    const detail = url.pathname.match(
      /\/(?:gp\/video\/)?detail\/([A-Za-z0-9]+)/i
    );
    if (detail?.[1]) return `detail:${detail[1].toLowerCase()}`;
    return `path:${url.pathname.toLowerCase()}`;
  } catch {
    return `href:${href}`;
  }
}

export function getPrimeCatalog(): PrimeCatalogSnapshot {
  return catalog;
}

export function subscribePrimeCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      logger.warn('Catalog listener failed', err);
    }
  }
}

export function clearPrimeCatalog(reason = 'reset'): void {
  const key = catalog.pageKey;
  catalog = emptyCatalog(key);
  logger.info('Prime catalog cleared', { reason, pageKey: key });
  notify();
}

export function resetPrimeCatalog(pageKey?: string): void {
  catalog = emptyCatalog(pageKey ?? pageKeyFromUrl());
  logger.info('Prime catalog reset', { pageKey: catalog.pageKey });
  notify();
}

export function clearPlaybackCatalog(reason = 'player_closed'): void {
  const pageKey = catalog.pageKey ?? pageKeyFromUrl();
  const keptEpisodes = catalog.episodes.map((ep) => ({
    ...ep,
    nowPlaying: false,
  }));
  const keepList = keptEpisodes.length > 0 && catalog.contentKind === 'show';

  catalog = {
    ...emptyCatalog(pageKey),
    contentKind: keepList ? 'show' : undefined,
    seriesTitle: keepList ? catalog.seriesTitle : undefined,
    episodes: keepList ? keptEpisodes : [],
    api: catalog.api,
  };
  logger.info('Playback catalog cleared', {
    reason,
    pageKey,
    keptEpisodes: catalog.episodes.length,
  });
  notify();
}

function markNowPlaying(
  episodes: CatalogEpisode[],
  activeGti?: string
): CatalogEpisode[] {
  const key = (activeGti || '').toLowerCase();
  return episodes.map((ep) => ({
    ...ep,
    nowPlaying: key ? ep.titleId.toLowerCase() === key : Boolean(ep.nowPlaying),
  }));
}

function catalogSignature(snapshot: PrimeCatalogSnapshot): string {
  return JSON.stringify([
    snapshot.contentKind,
    snapshot.playingGti,
    snapshot.focusEpisodeId,
    snapshot.parentGti,
    snapshot.seriesTitle,
    snapshot.movieTitle,
    snapshot.episodeTitle,
    snapshot.seasonNumber,
    snapshot.episodeNumber,
    snapshot.pageKey,
    snapshot.episodes.map((e) => `${e.titleId}:${e.name}:${e.nowPlaying ? 1 : 0}`),
  ]);
}

export function applyPrimeNetworkMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const msg = data as Record<string, unknown>;
  if (msg.source !== MESSAGE_SOURCE) return false;
  if (msg.type === 'hook_ready') {
    logger.info('Prime network hook ready');
    return false;
  }
  if (msg.type !== 'catalog') return false;

  // One page is either a show or a movie. Once this page is known to be a show
  // (episode metadata or episode list), a MOVIE-type entity is the background
  // preview/trailer — never what the user plays. Pressing Play on the resume
  // episode fires no new episode call, so accepting it (live or replayed from
  // the buffer) would leave the title stuck as a movie.
  if (
    msg.api === 'playerChrome' &&
    msg.contentKind === 'movie' &&
    catalog.contentKind === 'show' &&
    catalog.pageKey === pageKeyFromUrl()
  ) {
    logger.info('Ignored preview movie entity on a show page', {
      gti: msg.playingGti,
    });
    return false;
  }

  const before = catalogSignature(catalog);
  const changed = applyCatalogMessage(msg);
  if (!changed || catalogSignature(catalog) === before) return false;

  logger.info('Prime catalog updated', {
    api: catalog.api,
    contentKind: catalog.contentKind,
    playingGti: catalog.playingGti,
    episodeCount: catalog.episodes.length,
  });
  notify();
  return true;
}

function applyCatalogMessage(msg: Record<string, unknown>): boolean {

  const currentPageKey = pageKeyFromUrl();
  if (catalog.pageKey && catalog.pageKey !== currentPageKey) {
    catalog = emptyCatalog(currentPageKey);
  } else if (!catalog.pageKey) {
    catalog.pageKey = currentPageKey;
  }

  const api = typeof msg.api === 'string' ? msg.api : undefined;
  const contentKind =
    msg.contentKind === 'movie' || msg.contentKind === 'show'
      ? msg.contentKind
      : undefined;

  const playingGti =
    typeof msg.playingGti === 'string' ? msg.playingGti : undefined;
  const focusEpisodeId =
    typeof msg.focusEpisodeId === 'string' ? msg.focusEpisodeId : undefined;
  const parentGti =
    typeof msg.parentGti === 'string' ? msg.parentGti : undefined;
  const seriesTitle =
    typeof msg.seriesTitle === 'string' ? msg.seriesTitle : undefined;
  const movieTitle =
    typeof msg.movieTitle === 'string' ? msg.movieTitle : undefined;
  const episodeTitle =
    typeof msg.episodeTitle === 'string' ? msg.episodeTitle : undefined;
  const seasonNumber =
    typeof msg.seasonNumber === 'number' ? msg.seasonNumber : undefined;
  const episodeNumber =
    typeof msg.episodeNumber === 'number' ? msg.episodeNumber : undefined;

  const episodesRaw = Array.isArray(msg.episodes) ? msg.episodes : [];
  const incomingEpisodes: CatalogEpisode[] = [];
  for (const item of episodesRaw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.titleId !== 'string' || !row.titleId) continue;
    const { name, label } = displayName({
      titleId: row.titleId,
      cardTitle: typeof row.cardTitle === 'string' ? row.cardTitle : undefined,
      cardSubtitle:
        typeof row.cardSubtitle === 'string' ? row.cardSubtitle : undefined,
    });
    incomingEpisodes.push({
      titleId: row.titleId,
      parentId: typeof row.parentId === 'string' ? row.parentId : undefined,
      cardTitle: typeof row.cardTitle === 'string' ? row.cardTitle : undefined,
      cardSubtitle:
        typeof row.cardSubtitle === 'string' ? row.cardSubtitle : undefined,
      contentType:
        typeof row.contentType === 'string' ? row.contentType : undefined,
      nowPlaying: Boolean(row.nowPlaying),
      name,
      label,
    });
  }

  const incomingGti = (playingGti || focusEpisodeId || '').toLowerCase();
  const previousGti = (catalog.playingGti || catalog.focusEpisodeId || '').toLowerCase();
  const gtiChanged = Boolean(
    incomingGti && previousGti && incomingGti !== previousGti
  );
  const kindChanged = Boolean(
    contentKind && catalog.contentKind && contentKind !== catalog.contentKind
  );

  if (gtiChanged || kindChanged) {
    const preserveList =
      !kindChanged &&
      contentKind !== 'movie' &&
      catalog.episodes.length > 0 &&
      incomingEpisodes.length === 0;
    const preserved = preserveList ? catalog.episodes : [];
    catalog = emptyCatalog(currentPageKey);
    if (preserved.length > 0) catalog.episodes = preserved;
  }

  const resolvedKind: 'movie' | 'show' | undefined =
    contentKind ||
    (incomingEpisodes.length > 0 || seriesTitle || episodeTitle
      ? 'show'
      : undefined) ||
    (movieTitle ? 'movie' : undefined) ||
    catalog.contentKind;

  const activeId = focusEpisodeId || playingGti || catalog.playingGti;

  let nextEpisodes: CatalogEpisode[] = [];
  if (resolvedKind === 'movie') {
    nextEpisodes = [];
  } else if (incomingEpisodes.length > 0) {
    const byId = new Map<string, CatalogEpisode>();
    for (const ep of catalog.episodes) byId.set(ep.titleId.toLowerCase(), ep);
    for (const ep of incomingEpisodes) byId.set(ep.titleId.toLowerCase(), ep);
    nextEpisodes = markNowPlaying([...byId.values()], activeId);
  } else {
    nextEpisodes = markNowPlaying(catalog.episodes, activeId);
  }

  catalog = {
    contentKind: resolvedKind,
    playingGti: playingGti || catalog.playingGti,
    focusEpisodeId:
      resolvedKind === 'show'
        ? focusEpisodeId || playingGti || catalog.focusEpisodeId
        : undefined,
    parentGti:
      resolvedKind === 'show' ? parentGti || catalog.parentGti : undefined,
    seriesTitle:
      resolvedKind === 'show'
        ? seriesTitle || catalog.seriesTitle
        : undefined,
    movieTitle:
      resolvedKind === 'movie'
        ? movieTitle || catalog.movieTitle
        : undefined,
    episodeTitle:
      resolvedKind === 'show'
        ? episodeTitle || catalog.episodeTitle
        : undefined,
    seasonNumber:
      resolvedKind === 'show'
        ? seasonNumber ?? catalog.seasonNumber
        : undefined,
    episodeNumber:
      resolvedKind === 'show'
        ? episodeNumber ?? catalog.episodeNumber
        : undefined,
    episodes: nextEpisodes,
    gtis: [
      ...new Set(
        [
          ...(Array.isArray(msg.gtis)
            ? msg.gtis.filter((g): g is string => typeof g === 'string')
            : []),
          playingGti,
          focusEpisodeId,
          parentGti,
        ].filter((g): g is string => Boolean(g))
      ),
    ],
    pageKey: currentPageKey,
    api: api || catalog.api,
    updatedAt: Date.now(),
  };

  if (resolvedKind === 'movie') {
    catalog.episodes = [];
    catalog.focusEpisodeId = undefined;
    catalog.parentGti = undefined;
    catalog.seriesTitle = undefined;
    catalog.episodeTitle = undefined;
    catalog.seasonNumber = undefined;
    catalog.episodeNumber = undefined;
  }

  // Ensure current episode appears even before episodeList arrives
  if (
    resolvedKind === 'show' &&
    catalog.playingGti &&
    !catalog.episodes.some(
      (e) => e.titleId.toLowerCase() === catalog.playingGti!.toLowerCase()
    )
  ) {
    const label =
      catalog.seasonNumber != null && catalog.episodeNumber != null
        ? `S${catalog.seasonNumber} E${catalog.episodeNumber}`
        : 'Current';
    const name = catalog.episodeTitle
      ? `${label} · ${catalog.episodeTitle}`
      : label;
    catalog.episodes = [
      {
        titleId: catalog.playingGti,
        parentId: catalog.parentGti,
        cardTitle: label,
        cardSubtitle: catalog.episodeTitle,
        name,
        label,
        nowPlaying: true,
        contentType: 'EPISODE',
      },
      ...catalog.episodes,
    ];
  }

  return true;
}

export function findCatalogEpisode(
  gtiOrName: string | null | undefined
): CatalogEpisode | undefined {
  if (!gtiOrName) return undefined;
  const key = gtiOrName.trim().toLowerCase();
  return catalog.episodes.find(
    (ep) =>
      ep.titleId.toLowerCase() === key ||
      ep.name.toLowerCase() === key ||
      ep.cardSubtitle?.toLowerCase() === key ||
      ep.cardTitle?.toLowerCase() === key
  );
}

export function activeCatalogEpisode(): CatalogEpisode | undefined {
  if (catalog.contentKind === 'movie') return undefined;
  const id = catalog.focusEpisodeId || catalog.playingGti;
  if (id) {
    const byId = findCatalogEpisode(id);
    if (byId) return byId;
  }
  return catalog.episodes.find((ep) => ep.nowPlaying);
}
