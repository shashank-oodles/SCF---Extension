/**
 * MAIN-world hook for Prime Video identity APIs:
 *
 * 1) playerChromeResources?desiredResources=catalogMetadataV2,playbackRestrictions
 *    → current play/resume title (movie OR episode) via identifier + catalog
 *
 * 2) playerChromeResources?desiredResources=…,episodeList (shows only)
 *    → full episode list + focusEpisodeId / nowPlayingLabel
 *
 * 3) sonar.prime-video.amazon.dev payload titleId
 *    → what the web player is currently playing
 */
(() => {
  const SOURCE = 'SCF_PRIME_NETWORK';
  const GTI_RE = /amzn1\.dv\.gti\.[a-f0-9-]+/i;

  type EpisodeItem = {
    titleId: string;
    parentId?: string;
    cardTitle?: string;
    cardSubtitle?: string;
    contentType?: string;
    nowPlaying?: boolean;
  };

  function emit(payload: Record<string, unknown>): void {
    try {
      window.postMessage({ source: SOURCE, ...payload, at: Date.now() }, '*');
    } catch {
      // ignore
    }
  }

  function asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  }

  function extractGti(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const match = value.match(GTI_RE);
    return match ? match[0] : undefined;
  }

  function entityIdFromUrl(url: string): string | undefined {
    try {
      const parsed = new URL(url, location.href);
      return extractGti(parsed.searchParams.get('entityId') || '');
    } catch {
      return undefined;
    }
  }

  function classifyUrl(url: string): 'sonar' | 'playerChrome' | null {
    const lower = url.toLowerCase();
    if (lower.includes('sonar.prime-video.amazon') || lower.includes('/sonar')) {
      return 'sonar';
    }
    if (
      lower.includes('playerchromeresources') ||
      (lower.includes('atv-ps') && lower.includes('desiredresources'))
    ) {
      return 'playerChrome';
    }
    return null;
  }

  /** API 1 — catalogMetadataV2 + playbackRestrictions */
  function parseCatalogMetadata(raw: unknown): {
    gti?: string;
    contentKind?: 'movie' | 'show';
    movieTitle?: string;
    seriesTitle?: string;
    episodeTitle?: string;
    seasonNumber?: number;
    episodeNumber?: number;
  } {
    const root = asObject(raw);
    if (!root) return {};
    const resources = asObject(root.resources) || root;
    const meta = asObject(resources.catalogMetadataV2);
    const catalog = asObject(meta?.catalog);
    if (!catalog) return {};

    const restrictions = asObject(resources.playbackRestrictions);
    const gti = extractGti(restrictions?.identifier);
    const type = String(catalog.type || '').toUpperCase();
    const entityType = String(catalog.entityType || '').toLowerCase();

    const seasonNumber =
      typeof catalog.seasonNumber === 'number' ? catalog.seasonNumber : undefined;
    const episodeNumber =
      typeof catalog.episodeNumber === 'number'
        ? catalog.episodeNumber
        : undefined;
    const title =
      typeof catalog.title === 'string' && catalog.title.trim()
        ? catalog.title.trim()
        : undefined;
    const seriesTitle =
      typeof catalog.seriesTitle === 'string' && catalog.seriesTitle.trim()
        ? catalog.seriesTitle.trim()
        : undefined;

    if (type === 'MOVIE' || entityType === 'movie') {
      return {
        gti,
        contentKind: 'movie',
        movieTitle: title,
      };
    }

    if (type === 'EPISODE' || entityType.includes('tv') || seriesTitle) {
      return {
        gti,
        contentKind: 'show',
        seriesTitle,
        episodeTitle: title,
        seasonNumber,
        episodeNumber,
      };
    }

    return { gti, movieTitle: title, seriesTitle };
  }

  /** API 2 — episodeList carousel (shows only) */
  function parseEpisodeList(raw: unknown): {
    episodes: EpisodeItem[];
    focusEpisodeId?: string;
    parentGti?: string;
  } {
    const root = asObject(raw);
    if (!root) return { episodes: [] };
    const resources = asObject(root.resources) || root;
    const episodeList = asObject(resources.episodeList);
    const carousel = asObject(episodeList?.carousel);
    if (!carousel) return { episodes: [] };

    const focusEpisodeId = extractGti(
      typeof carousel.focusEpisodeId === 'string' ? carousel.focusEpisodeId : ''
    );
    const items = Array.isArray(carousel.carouselItems)
      ? carousel.carouselItems
      : [];

    const episodes: EpisodeItem[] = [];
    let parentGti: string | undefined;

    for (const item of items) {
      const row = asObject(item);
      if (!row) continue;
      const titleId = extractGti(row.titleId);
      if (!titleId) continue;
      const parentId = extractGti(row.parentId);
      if (parentId && !parentGti) parentGti = parentId;

      const nowPlaying =
        Boolean(row.nowPlayingLabel) ||
        (focusEpisodeId != null &&
          titleId.toLowerCase() === focusEpisodeId.toLowerCase());

      episodes.push({
        titleId,
        parentId,
        cardTitle:
          typeof row.cardTitle === 'string' ? row.cardTitle : undefined,
        cardSubtitle:
          typeof row.cardSubtitle === 'string' ? row.cardSubtitle : undefined,
        contentType:
          typeof row.contentType === 'string' ? row.contentType : 'EPISODE',
        nowPlaying,
      });
    }

    return { episodes, focusEpisodeId, parentGti };
  }

  /** API 3 — Sonar request payload */
  function parseSonarRequest(requestText?: string): {
    titleId?: string;
    contentKind?: 'movie' | 'show';
  } {
    if (!requestText) return {};
    try {
      const body = asObject(JSON.parse(requestText));
      if (!body) return {};
      const titleId = extractGti(body.titleId);
      const contentType = String(body.contentType || '').toLowerCase();
      if (contentType === 'feature' || contentType === 'movie') {
        return { titleId, contentKind: 'movie' };
      }
      if (
        contentType === 'episode' ||
        contentType === 'season' ||
        contentType === 'series'
      ) {
        return { titleId, contentKind: 'show' };
      }
      return { titleId };
    } catch {
      return { titleId: extractGti(requestText) };
    }
  }

  function handleJson(url: string, data: unknown, requestText?: string): void {
    const api = classifyUrl(url);
    if (!api) return;

    const entityId = entityIdFromUrl(url);

    if (api === 'sonar') {
      const sonar = parseSonarRequest(requestText);
      if (!sonar.titleId && !entityId) return;
      emit({
        type: 'catalog',
        api: 'sonar',
        url,
        contentKind: sonar.contentKind || null,
        playingGti: sonar.titleId || entityId || null,
        focusEpisodeId:
          sonar.contentKind === 'show' || !sonar.contentKind
            ? sonar.titleId || entityId || null
            : null,
        movieTitle: null,
        seriesTitle: null,
        episodeTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        parentGti: null,
        episodes: [],
        gtis: [sonar.titleId || entityId].filter(Boolean),
      });
      return;
    }

    // playerChromeResources — may include metadata, episodeList, or both
    const meta = parseCatalogMetadata(data);
    const list = parseEpisodeList(data);

    const contentKind =
      meta.contentKind ||
      (list.episodes.length > 0 ? 'show' : undefined) ||
      null;

    const playingGti =
      meta.gti ||
      list.focusEpisodeId ||
      entityId ||
      list.episodes.find((e) => e.nowPlaying)?.titleId ||
      null;

    const focusEpisodeId =
      contentKind === 'movie'
        ? null
        : list.focusEpisodeId ||
          meta.gti ||
          list.episodes.find((e) => e.nowPlaying)?.titleId ||
          playingGti;

    if (
      !playingGti &&
      !meta.movieTitle &&
      !meta.seriesTitle &&
      list.episodes.length === 0
    ) {
      return;
    }

    emit({
      type: 'catalog',
      api: 'playerChrome',
      url,
      contentKind,
      playingGti,
      focusEpisodeId,
      parentGti: list.parentGti || null,
      movieTitle: meta.movieTitle || null,
      seriesTitle: meta.seriesTitle || null,
      episodeTitle: meta.episodeTitle || null,
      seasonNumber: meta.seasonNumber ?? null,
      episodeNumber: meta.episodeNumber ?? null,
      episodes: contentKind === 'movie' ? [] : list.episodes,
      gtis: [
        playingGti,
        focusEpisodeId,
        list.parentGti,
        ...list.episodes.map((e) => e.titleId),
      ].filter(Boolean),
    });
  }

  async function readBodyText(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<string | undefined> {
    if (typeof init?.body === 'string') return init.body;
    if (init?.body instanceof URLSearchParams) return init.body.toString();
    if (input instanceof Request) {
      try {
        return await input.clone().text();
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async function readResponseClone(response: Response): Promise<string | null> {
    try {
      return await response.clone().text();
    } catch {
      return null;
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const init = args[1];
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    const kind = classifyUrl(url);
    // Don't await body before fetch — that stalls Prime's own requests
    const requestTextPromise =
      kind === 'sonar' ? readBodyText(input, init) : Promise.resolve(undefined);

    const response = await originalFetch(...args);
    if (kind) {
      void Promise.all([requestTextPromise, readResponseClone(response)]).then(
        ([requestText, text]) => {
          if (!text && !requestText) return;
          try {
            handleJson(url, text ? JSON.parse(text) : {}, requestText);
          } catch {
            if (requestText) handleJson(url, {}, requestText);
          }
        }
      );
    }
    return response;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    (this as XMLHttpRequest & { __scfUrl?: string }).__scfUrl = String(url);
    return xhrOpen.apply(this, [method, url, ...rest] as never);
  };

  XMLHttpRequest.prototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    const url = (this as XMLHttpRequest & { __scfUrl?: string }).__scfUrl || '';
    const kind = classifyUrl(url);
    const requestText = typeof body === 'string' ? body : undefined;

    if (kind) {
      this.addEventListener('load', function () {
        try {
          const text = this.responseText;
          if (!text) {
            if (requestText) handleJson(url, {}, requestText);
            return;
          }
          handleJson(url, JSON.parse(text), requestText);
        } catch {
          if (requestText) handleJson(url, {}, requestText);
        }
      });
    }

    return xhrSend.call(this, body);
  };

  emit({ type: 'hook_ready' });
})();
