import type { TitleFilterConfig } from '../types';
import { collectPriorityMatchText } from './filterApi';
import { logger } from '../utils/logger';

export interface SeriesMatchResult {
  /** Normalized key used for session selection memory */
  seriesKey: string;
  /** Human label shown in the overlay */
  seriesLabel: string;
  /** Why this series was detected */
  reasons: string[];
  /** All filter configs belonging to this series/movie hit */
  candidates: TitleFilterConfig[];
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function extractAsins(text: string): string[] {
  const found = new Set<string>();
  const re = /\/(?:gp\/video\/)?detail\/([a-z0-9]{8,})/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    found.add(match[1].toLowerCase());
  }
  // Bare ASIN-looking tokens from matchPatterns may also appear in the URL path
  return [...found];
}

function configAsins(config: TitleFilterConfig): string[] {
  const asins = new Set<string>();
  for (const pattern of config.matchPatterns) {
    const fromPath = pattern.match(/\/(?:gp\/video\/)?detail\/([a-z0-9]{8,})/i);
    if (fromPath?.[1]) asins.add(fromPath[1].toLowerCase());
    if (/^[a-z0-9]{8,}$/i.test(pattern.trim())) {
      asins.add(pattern.trim().toLowerCase());
    }
  }
  if (config.videoUrl) {
    for (const id of extractAsins(config.videoUrl)) asins.add(id);
  }
  return [...asins];
}

function displayLabel(config: TitleFilterConfig): string {
  if (config.kind === 'show' && config.episodeName?.trim()) {
    return `${config.title} — ${config.episodeName.trim()}`;
  }
  return config.title;
}

/**
 * Detect which show/movie family the open player belongs to, without
 * requiring an exact episode-name match. Returns all configs for that family
 * so the user can pick the episode in the overlay.
 */
export function findSeriesCandidates(
  configs: TitleFilterConfig[],
  pageUrl: string = location.href,
  pageTitle: string = document.title
): SeriesMatchResult | null {
  const priority = collectPriorityMatchText(pageUrl, pageTitle).toLowerCase();
  const haystack = `${pageUrl}\n${pageTitle}\n${priority}`.toLowerCase();
  const pageAsins = extractAsins(haystack);

  logger.info('Series detect input', {
    href: pageUrl,
    documentTitle: pageTitle,
    pageAsins,
    priorityPreview: priority.slice(0, 200),
  });

  type Group = {
    seriesKey: string;
    seriesLabel: string;
    reasons: string[];
    candidates: TitleFilterConfig[];
    score: number;
  };

  const groups = new Map<string, Group>();

  const ensureGroup = (
    key: string,
    label: string,
    reason: string,
    scoreBoost: number
  ): Group => {
    let group = groups.get(key);
    if (!group) {
      group = {
        seriesKey: key,
        seriesLabel: label,
        reasons: [],
        candidates: [],
        score: 0,
      };
      groups.set(key, group);
    }
    if (!group.reasons.includes(reason)) group.reasons.push(reason);
    group.score += scoreBoost;
    return group;
  };

  for (const config of configs) {
    const asins = configAsins(config);
    const asinHit = asins.find((id) => pageAsins.includes(id) || haystack.includes(id));
    const titleKey = normalizeKey(config.title);
    const titleHit =
      titleKey.length >= 2 &&
      (haystack.includes(titleKey) ||
        // allow loose case variants already lowercased in haystack
        priority.includes(titleKey));

    if (!asinHit && !titleHit) continue;

    if (config.kind === 'show') {
      const group = ensureGroup(
        `show:${titleKey}`,
        config.title,
        asinHit ? `ASIN ${asinHit}` : `show title "${config.title}"`,
        asinHit ? 100 : 40
      );
      if (!group.candidates.some((c) => c.titleId === config.titleId)) {
        group.candidates.push(config);
      }
    } else {
      // Movies stay as their own selectable group (usually one item)
      const group = ensureGroup(
        `movie:${config.titleId}`,
        config.title,
        asinHit ? `ASIN ${asinHit}` : `movie title "${config.title}"`,
        asinHit ? 120 : 50
      );
      if (!group.candidates.some((c) => c.titleId === config.titleId)) {
        group.candidates.push(config);
      }
    }
  }

  // Merge show groups that share an ASIN on this page (e.g. "FROM" vs "FROm")
  if (pageAsins.length > 0) {
    const showGroups = [...groups.values()].filter((g) =>
      g.seriesKey.startsWith('show:')
    );
    for (let i = 0; i < showGroups.length; i++) {
      for (let j = i + 1; j < showGroups.length; j++) {
        const a = showGroups[i];
        const b = showGroups[j];
        const aAsins = new Set(a.candidates.flatMap(configAsins));
        const bAsins = new Set(b.candidates.flatMap(configAsins));
        const overlap = pageAsins.some((id) => aAsins.has(id) && bAsins.has(id));
        if (!overlap) continue;

        for (const c of b.candidates) {
          if (!a.candidates.some((x) => x.titleId === c.titleId)) {
            a.candidates.push(c);
          }
        }
        a.score += b.score;
        a.reasons.push(`merged with ${b.seriesLabel}`);
        groups.delete(b.seriesKey);
      }
    }
  }

  const ranked = [...groups.values()].sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return null;

  const best = ranked[0];
  best.candidates.sort((a, b) => {
    const aLabel = displayLabel(a).toLowerCase();
    const bLabel = displayLabel(b).toLowerCase();
    return aLabel.localeCompare(bLabel);
  });

  logger.info('Series candidates', {
    seriesKey: best.seriesKey,
    seriesLabel: best.seriesLabel,
    reasons: best.reasons,
    candidateIds: best.candidates.map((c) => c.titleId),
    episodes: best.candidates.map((c) => c.episodeName || c.title),
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
