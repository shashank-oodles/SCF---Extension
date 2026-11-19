import type { TitleFilterConfig } from '../types';
import { formatCandidateLabel } from '../services/seriesMatch';

const ROOT_ID = 'scf-title-picker';

export type TitlePickHandler = (config: TitleFilterConfig) => void;

/**
 * In-player overlay: lists filter configs for a detected show/movie so the
 * user can choose which episode/title filters to apply.
 */
export class TitlePickerOverlay {
  private root: HTMLDivElement | null = null;
  private onPick: TitlePickHandler | null = null;
  private candidates: TitleFilterConfig[] = [];
  private selectedId: string | null = null;
  private seriesLabel = '';
  private collapsed = false;

  mount(): void {
    if (document.getElementById(ROOT_ID)) {
      this.root = document.getElementById(ROOT_ID) as HTMLDivElement;
      return;
    }

    const el = document.createElement('div');
    el.id = ROOT_ID;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'SCF title picker');
    Object.assign(el.style, {
      position: 'fixed',
      left: '16px',
      bottom: '88px',
      zIndex: '2147483647',
      width: '320px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'min(420px, 60vh)',
      display: 'none',
      flexDirection: 'column',
      borderRadius: '12px',
      background: 'rgba(16, 22, 28, 0.96)',
      color: '#f4f6f8',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '13px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
      border: '1px solid rgba(255,255,255,0.08)',
      overflow: 'hidden',
      pointerEvents: 'auto',
    } as CSSStyleDeclaration);

    document.documentElement.appendChild(el);
    this.root = el;
  }

  /**
   * Show candidate list for a detected series/movie.
   */
  show(options: {
    seriesLabel: string;
    candidates: TitleFilterConfig[];
    selectedId?: string | null;
    onPick: TitlePickHandler;
  }): void {
    this.mount();
    if (!this.root) return;

    this.seriesLabel = options.seriesLabel;
    this.candidates = options.candidates;
    this.selectedId = options.selectedId ?? null;
    this.onPick = options.onPick;
    this.collapsed = Boolean(options.selectedId);
    this.root.style.display = 'flex';
    this.render();
  }

  setSelected(titleId: string | null): void {
    this.selectedId = titleId;
    this.collapsed = Boolean(titleId);
    this.render();
  }

  hide(): void {
    if (!this.root) return;
    this.root.style.display = 'none';
    this.candidates = [];
    this.selectedId = null;
    this.onPick = null;
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
  }

  private render(): void {
    if (!this.root) return;

    const selected = this.candidates.find((c) => c.titleId === this.selectedId);

    if (this.collapsed && selected) {
      this.root.innerHTML = `
        <div style="padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="min-width:0;">
            <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.65;">SCF filtering</div>
            <div style="font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${escapeHtml(formatCandidateLabel(selected))}
            </div>
            <div style="opacity:0.7;margin-top:2px;font-size:12px;">
              ${selected.filters.length} filter${selected.filters.length === 1 ? '' : 's'} active
            </div>
          </div>
          <button type="button" data-scf-action="expand" style="${buttonStyle()}">Change</button>
        </div>
      `;
      this.bind();
      return;
    }

    const rows = this.candidates
      .map((config) => {
        const active = config.titleId === this.selectedId;
        const ep =
          config.kind === 'show' && config.episodeName
            ? config.episodeName
            : config.title;
        return `
          <button
            type="button"
            data-scf-title-id="${escapeHtml(config.titleId)}"
            style="
              display:block;width:100%;text-align:left;padding:10px 12px;border:0;cursor:pointer;
              background:${active ? 'rgba(26,122,92,0.35)' : 'transparent'};
              color:#f4f6f8;border-bottom:1px solid rgba(255,255,255,0.06);
            "
          >
            <div style="font-weight:600;">${escapeHtml(ep)}</div>
            <div style="opacity:0.65;font-size:11px;margin-top:2px;">
              ${escapeHtml(config.titleId)} · ${config.filters.length} filter${config.filters.length === 1 ? '' : 's'}
            </div>
          </button>
        `;
      })
      .join('');

    this.root.innerHTML = `
      <div style="padding:12px 14px 8px;border-bottom:1px solid rgba(255,255,255,0.08);">
        <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.65;">SCF · choose title</div>
        <div style="font-weight:700;margin-top:4px;font-size:15px;">${escapeHtml(this.seriesLabel)}</div>
        <div style="opacity:0.7;margin-top:4px;font-size:12px;">
          ${this.candidates.length} saved filter set${this.candidates.length === 1 ? '' : 's'} — pick the episode you’re watching
        </div>
      </div>
      <div style="overflow:auto;flex:1;">${rows || `<div style="padding:16px;opacity:0.7;">No titles found</div>`}</div>
      ${
        this.selectedId
          ? `<div style="padding:8px 12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:flex-end;">
              <button type="button" data-scf-action="collapse" style="${buttonStyle()}">Done</button>
            </div>`
          : ''
      }
    `;
    this.bind();
  }

  private bind(): void {
    if (!this.root) return;

    this.root
      .querySelector('[data-scf-action="expand"]')
      ?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.collapsed = false;
        this.render();
      });

    this.root
      .querySelector('[data-scf-action="collapse"]')
      ?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.collapsed = true;
        this.render();
      });

    this.root.querySelectorAll('[data-scf-title-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = (btn as HTMLElement).getAttribute('data-scf-title-id');
        const config = this.candidates.find((c) => c.titleId === id);
        if (!config || !this.onPick) return;
        this.selectedId = config.titleId;
        this.collapsed = true;
        this.onPick(config);
        this.render();
      });
    });
  }
}

function buttonStyle(): string {
  return `
    border:0;border-radius:8px;padding:7px 10px;cursor:pointer;
    background:#1a7a5c;color:white;font-weight:600;font-size:12px;flex-shrink:0;
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
