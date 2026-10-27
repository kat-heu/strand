// In-app dialogs. The desktop app (Electron) doesn't support window.prompt(),
// so every text question and confirmation goes through these instead.
import { h } from './util.js';

function open({ title, message, input, okLabel = 'OK', cancelLabel = 'Cancel', danger = false, readonly = false }) {
  return new Promise(resolve => {
    const field = input !== undefined
      ? h('input', { class: 'input', value: input.value || '', placeholder: input.placeholder || '', readonly, spellcheck: false })
      : null;
    if (field) field.value = input.value || '';
    const done = val => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); };
    const ok = h('button', { class: 'btn primary' + (danger ? ' danger' : ''), onClick: () => done(field ? field.value.trim() : true) }, okLabel);
    const cancel = cancelLabel ? h('button', { class: 'btn ghost', onClick: () => done(field ? null : false) }, cancelLabel) : null;
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h3', {}, title), message ? h('p', { class: 'muted' }, message) : null, field,
      h('div', { class: 'dialog-actions' }, cancel, ok));
    const overlay = h('div', { class: 'dialog-overlay', onClick: e => { if (e.target === overlay) done(field ? null : false); } }, box);
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); done(field ? null : false); }
      else if (e.key === 'Enter' && document.activeElement !== cancel) { e.preventDefault(); ok.click(); }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    setTimeout(() => { if (field) { field.focus(); field.select(); } else ok.focus(); }, 20);
  });
}

// Resolves to the trimmed text, or null if cancelled / left empty.
export async function askText(title, { value = '', placeholder = '', message = '', okLabel = 'Save' } = {}) {
  const v = await open({ title, message, input: { value, placeholder }, okLabel });
  return v ? v : null;
}
export const askConfirm = (title, { message = '', okLabel = 'OK', danger = false } = {}) =>
  open({ title, message, okLabel, danger });
export const showText = (title, text, message = '') =>
  open({ title, message, input: { value: text }, okLabel: 'Done', cancelLabel: null, readonly: true });
