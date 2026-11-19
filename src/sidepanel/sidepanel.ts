import type { ExtensionStatus } from '../types';
import type { SidePanelCandidate, SidePanelState } from '../types/panel';

const statusPill = document.getElementById('status-pill') as HTMLDivElement;
const playerDetail = document.getElementById('player-detail') as HTMLParagraphElement;
const seriesCard = document.getElementById('series-card') as HTMLElement;
const seriesLabel = document.getElementById('series-label') as HTMLHeadingElement;
const seriesDetail = document.getElementById('series-detail') as HTMLParagraphElement;
const candidateList = document.getElementById('candidate-list') as HTMLDivElement;
const activeCard = document.getElementById('active-card') as HTMLElement;
const activeTitle = document.getElementById('active-title') as HTMLParagraphElement;
const activeMeta = document.getElementById('active-meta') as HTMLParagraphElement;
const activeFilters = document.getElementById('active-filters') as HTMLUListElement;

function pillClass(status: ExtensionStatus): string {
  if (status === 'filtering_active' || status === 'filters_loaded') return 'pill pill-ok';
  if (status === 'backend_failed') return 'pill pill-danger';
  if (status === 'title_not_matched' || status === 'awaiting_selection') {
    return 'pill pill-warn';
  }
  return 'pill pill-neutral';
}

function statusLabel(status: ExtensionStatus): string {
  switch (status) {
    case 'filtering_active':
      return 'Filtering';
    case 'awaiting_selection':
      return 'Choose title';
    case 'title_not_matched':
      return 'No match';
    case 'backend_failed':
      return 'Backend down';
    case 'video_detected':
      return 'Player detected';
    case 'filters_loaded':
      return 'Filters loaded';
    default:
      return 'Waiting';
  }
}

function candidateLabel(c: SidePanelCandidate): string {
  if (c.kind === 'show' && c.episodeName) return c.episodeName;
  return c.title;
}

function formatInterval(start: number, end: number): string {
  const fmt = (n: number) => {
    const m = Math.floor(n / 60);
    const s = Math.floor(n % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

function render(state: SidePanelState): void {
  statusPill.className = pillClass(state.status);
  statusPill.textContent = statusLabel(state.status);

  if (!state.playerOpen) {
    playerDetail.textContent =
      state.statusDetail || 'Open a Prime Video title and press play.';
    seriesCard.hidden = true;
    activeCard.hidden = true;
    return;
  }

  playerDetail.textContent =
    state.statusDetail || 'Player is open. Pick a title below to apply filters.';

  if (!state.candidates.length) {
    seriesCard.hidden = false;
    seriesLabel.textContent = 'No SCF titles';
    seriesDetail.textContent =
      'No saved filters matched this player. Add the title in the SCF dashboard.';
    candidateList.innerHTML = `<div class="empty">Nothing to select yet</div>`;
    activeCard.hidden = true;
    return;
  }

  seriesCard.hidden = false;
  seriesLabel.textContent = state.seriesLabel || 'Matched titles';
  seriesDetail.textContent = `${state.candidates.length} saved filter set${
    state.candidates.length === 1 ? '' : 's'
  } — select the episode you’re watching.`;

  candidateList.innerHTML = '';
  for (const candidate of state.candidates) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      candidate.titleId === state.selectedId ? 'candidate active' : 'candidate';
    btn.innerHTML = `
      <div class="candidate-title">${escapeHtml(candidateLabel(candidate))}</div>
      <div class="candidate-meta">${escapeHtml(candidate.titleId)} · ${
        candidate.filterCount
      } filter${candidate.filterCount === 1 ? '' : 's'}</div>
    `;
    btn.addEventListener('click', () => {
      void chrome.runtime.sendMessage({
        type: 'SCF_SELECT_TITLE',
        titleId: candidate.titleId,
      });
    });
    candidateList.appendChild(btn);
  }

  const selected = state.candidates.find((c) => c.titleId === state.selectedId);
  if (!selected) {
    activeCard.hidden = true;
    return;
  }

  activeCard.hidden = false;
  activeTitle.textContent = candidateLabel(selected);
  activeMeta.textContent = `${selected.titleId} · ${selected.filterCount} active filter${
    selected.filterCount === 1 ? '' : 's'
  }`;
  activeFilters.innerHTML = selected.filters
    .map(
      (f) => `
        <li>
          <span>${escapeHtml(f.label || formatInterval(f.start, f.end))}</span>
          <span class="action">${escapeHtml(f.action)}</span>
        </li>
      `
    )
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadState(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: 'SCF_GET_STATE',
  })) as { state?: SidePanelState } | undefined;

  if (response?.state) {
    render(response.state);
    return;
  }

  render({
    playerOpen: false,
    sidePanelOpen: true,
    status: 'initialized',
    candidates: [],
    selectedId: null,
    updatedAt: Date.now(),
  });
}

/** Keep a port open so the background knows the side panel is visible. */
function connectPanelPort(): void {
  const port = chrome.runtime.connect({ name: 'scf-sidepanel' });
  port.onMessage.addListener((message) => {
    if (message?.type === 'SCF_STATE' && message.state) {
      render(message.state as SidePanelState);
    }
  });
  port.onDisconnect.addListener(() => {
    // Panel closing — background updates content-script status dot
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'SCF_STATE' && message.state) {
    render(message.state as SidePanelState);
  }
});

connectPanelPort();
void loadState();
