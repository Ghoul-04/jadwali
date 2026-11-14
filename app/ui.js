// app/ui.js — small HTML component helpers (string templates).
import { KIND_NAMES, time12 } from '../core/schedule.js';
import { icons } from './icons.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function t12(min) {
  const t = time12(min);
  return `<span class="t"><bdi>${t.text}</bdi><small>${t.ampm}</small></span>`;
}

export function range12(a, b) {
  return `<span class="range">${t12(a)}<span class="dash">–</span>${t12(b)}</span>`;
}

export function pad2(n) { return String(n).padStart(2, '0'); }

/** "01:23:45" or "23:45" */
export function clock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** Periodic-table element tile. */
export function tile(data, subjectId, { size = 'md', extra = '' } = {}) {
  const sub = data.subjects[subjectId];
  const n = Object.keys(data.subjects).indexOf(subjectId) + 1;
  return `<div class="el s-${subjectId} el--${size} ${extra}" aria-hidden="true">
    <span class="el-n">${n}</span><span class="el-sym">${esc(sub.symbol)}</span><span class="el-nick">${esc(sub.nick)}</span>
  </div>`;
}

export function kindPill(kind) {
  return `<span class="pill k-${kind}">${KIND_NAMES[kind] || kind}</span>`;
}

function tags(x) {
  const out = [];
  if (x.subject === 'heat1' && x.fromStage) out.push(`<span class="tag tag-heat">${esc(x.fromStage)}</span>`);
  if (x.labGroup) out.push(`<span class="tag">كروب ${x.labGroup}${x.groupUncertain ? ' · حسب كروبك' : ''}</span>`);
  if (x.amended) out.push(`<span class="tag tag-amend">${esc(x.note || 'تعديل القسم')}</span>`);
  if (x.cancelled) out.push('<span class="tag tag-cancel">ملغية لهذا اليوم</span>');
  return out.join('');
}

export function sessionCard(data, x, { i = 0, compact = false } = {}) {
  const sub = data.subjects[x.subject];
  const cls = ['card', 'sess', `s-${x.subject}`, x.dimmed ? 'is-dim' : '', x.cancelled ? 'is-cancel' : ''].join(' ');
  return `<article class="${cls}" style="--i:${i}" data-act="detail" data-key="${esc(x.key)}" tabindex="0" role="button" aria-label="${esc(sub.name)}">
    ${tile(data, x.subject, { size: compact ? 'sm' : 'md' })}
    <div class="sess-body">
      <h3 class="sess-name">${esc(sub.name)}</h3>
      <div class="sess-meta">${kindPill(x.kind)}${x.instructor ? `<span class="who">${esc(x.instructor)}</span>` : ''}</div>
      <div class="sess-loc">${icons.pin()}<span>${esc(x.location)}</span>${tags(x)}</div>
    </div>
  </article>`;
}

/** A clash rendered as a split card with a "رايح لهاي" button on each side. */
export function clashCard(data, e, { i = 0, readOnly = false, goingLabel = 'رايح لهاي' } = {}) {
  const sides = e.sessions.map((x) => {
    const sub = data.subjects[x.subject];
    const chosen = e.chosen === x.key;
    return `<div class="clash-side s-${x.subject} ${x.dimmed ? 'is-dim' : ''} ${chosen ? 'is-chosen' : ''} ${x.cancelled ? 'is-cancel' : ''}">
      <button class="clash-info" data-act="detail" data-key="${esc(x.key)}" aria-label="${esc(sub.name)}">
        ${tile(data, x.subject, { size: 'sm' })}
        <span class="clash-name">${esc(sub.name)}</span>
        <span class="sess-meta">${kindPill(x.kind)}</span>
        <span class="sess-loc">${icons.pin()}<span>${esc(x.location)}</span></span>
        <span class="clash-tags">${tags(x)}</span>
      </button>
      ${readOnly ? '' : `<button class="btn-go ${chosen ? 'on' : ''}" data-act="choose" data-clash="${esc(e.id)}" data-key="${esc(x.key)}" aria-pressed="${chosen}">
        ${chosen ? icons.check() + '<span>رايح</span>' : `<span>${goingLabel}</span>`}</button>`}
    </div>`;
  });
  return `<section class="card clash" style="--i:${i}">
    <header class="clash-head">${icons.clash()}<span>تصادم</span>${range12(e.start, e.end)}${e.chosen && !readOnly ? `<button class="link" data-act="unchoose" data-clash="${esc(e.id)}">تراجع</button>` : ''}</header>
    <div class="clash-split">${sides.join('<span class="clash-vs" aria-hidden="true">✕</span>')}</div>
  </section>`;
}

/** Circular "reactor gauge": progress 0..1 with tick marks. */
export function ring(progress, { size = 148, color = 'var(--c1)', color2 = 'var(--c2)', inner = '' } = {}) {
  const r = 58, C = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  const ticks = Array.from({ length: 48 }, (_, k) => {
    const a = (k / 48) * 2 * Math.PI;
    const long = k % 4 === 0;
    const r1 = long ? 66 : 68, r2 = 72;
    const x1 = 80 + r1 * Math.sin(a), y1 = 80 - r1 * Math.cos(a);
    const x2 = 80 + r2 * Math.sin(a), y2 = 80 - r2 * Math.cos(a);
    const lit = k / 48 <= p;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="tick ${lit ? 'lit' : ''} ${long ? 'long' : ''}"/>`;
  }).join('');
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  return `<div class="ring" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 160 160" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color2}"/></linearGradient></defs>
      ${ticks}
      <circle cx="80" cy="80" r="${r}" class="ring-track"/>
      <circle cx="80" cy="80" r="${r}" class="ring-bar" stroke="url(#${id})" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - p)).toFixed(1)}" transform="rotate(-90 80 80)" data-ring-c="${C.toFixed(1)}"/>
    </svg>
    <div class="ring-inner">${inner}</div>
  </div>`;
}

export function segmented(name, value, options, { act = 'set' } = {}) {
  return `<div class="seg" role="radiogroup" style="--n:${options.length}">
    ${options.map(([v, label]) => `<button role="radio" aria-checked="${v === value}" class="${v === value ? 'on' : ''}" data-act="${act}" data-name="${name}" data-value="${v}">${label}</button>`).join('')}
  </div>`;
}

export function toggle(name, on, label, { act = 'toggle' } = {}) {
  return `<label class="switch-row"><span>${label}</span>
    <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-act="${act}" data-name="${name}" aria-label="${esc(label)}"><i></i></button></label>`;
}
