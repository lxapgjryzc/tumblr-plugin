'use strict';
// Small DOM helpers shared by the pages. No framework: h() builds elements, pages re-render their own root.

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
};
const $ = (s, r = document) => r.querySelector(s);
const call = async (m, a) => {
  try { return await window.studio.call(m, a); }
  catch (e) { toast(cleanErr(e), 'error'); throw e; }
};
const cleanErr = e => String(e?.message || e).replace(/^Error invoking remote method 'studio': (Error: )?/, '');

function toast(msg, kind = 'info', ms = 4000) {
  if (kind === 'error' && typeof clientLog === 'function') clientLog('warn', 'toast', msg);
  const el = h('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// A modal with custom buttons; never a native dialog. Resolves with the clicked button's value (or null).
function modal(title, body, buttons = [{ label: t('close'), value: null }], { wide = false } = {}) {
  return new Promise(resolve => {
    const close = v => { back.remove(); resolve(v); };
    const back = h('div', { class: 'modal-back', onclick: e => { if (e.target === back) close(null); } },
      h('div', { class: 'modal' + (wide ? ' wide' : '') },
        h('header', {}, h('h2', {}, title), h('button', { class: 'ghost icon', onclick: () => close(null), title: t('close') }, '✕')),
        h('div', { class: 'modal-body' }, body),
        h('footer', {}, buttons.map(b => h('button', { class: b.class || '', disabled: b.disabled, onclick: () => close(typeof b.value === 'function' ? b.value() : b.value) }, b.label)))));
    document.body.append(back);
    back.querySelector('footer button:last-child')?.focus();
  });
}

const fmtDate = ms => (ms ? new Date(ms).toLocaleDateString(LANG === 'zh' ? 'zh-CN' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtTime = ms => (ms ? new Date(ms).toLocaleString(LANG === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const ago = ms => {
  if (!ms) return t('never');
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return t('justNow');
  if (s < 3600) return t('minAgo', Math.round(s / 60));
  if (s < 86400) return t('hourAgo', Math.round(s / 3600));
  return t('dayAgo', Math.round(s / 86400));
};
const inDays = ms => Math.ceil((ms - Date.now()) / 86400e3);

const stateBadge = s => h('span', { class: 'badge st-' + s }, t('state_' + s));
const blogName = (uuid) => (App.status?.blogs || []).find(b => b.uuid === uuid)?.name || uuid;

function select(options, value, onchange, attrs = {}) {
  return h('select', { ...attrs, onchange: e => onchange(e.target.value) },
    options.map(o => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
}
function chips(options, value, onchange) {
  return h('div', { class: 'chips' }, options.map(o => h('button', { class: 'chip' + (String(o.value) === String(value) ? ' on' : ''), onclick: () => onchange(o.value) }, o.label)));
}
function toggle(checked, onchange, label) {
  return h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked, onchange: e => onchange(e.target.checked) }), h('span', { class: 'track' }), label ? h('span', {}, label) : null);
}
const empty = (msg, ...extra) => h('div', { class: 'empty' }, h('p', {}, msg), ...extra);

// Pages pass optional parts as null/false; skip them instead of printing "null"
{
  const orig = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter(k => k != null && k !== false)); };
  const origAppend = Element.prototype.append;
  Element.prototype.append = function (...kids) { return origAppend.apply(this, kids.flat(Infinity).filter(k => k != null && k !== false)); };
}

// General categories by group: [[group | null, categories]], groups in configured order, ungrouped last
function catSections(groups, cats) {
  const out = groups.map(g => [g, cats.filter(c => c.group_id === g.id)]);
  const loose = cats.filter(c => !groups.some(g => g.id === c.group_id));
  if (loose.length) out.push([null, loose]);
  return out.filter(([g, list]) => list.length || g);
}
const groupName = g => (!g ? t('ungrouped') : g.name || (g.key ? t('grp_' + g.key) : t('group')));
