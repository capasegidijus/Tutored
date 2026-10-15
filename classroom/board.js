'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const fields = ['date', 'subject', 'writing'].map($);
  const KEY = 'classroom-board.v1';
  const today = () => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  let previous = null, active = $('writing'), selection = null, dateManual = false;
  let fullScreenFallback = false;
  const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
  // Retain only writing markup, including when old local storage has been altered.
  function clean(html) {
    const template = document.createElement('template');
    template.innerHTML = typeof html === 'string' ? html : '';
    const allowed = new Set(['DIV', 'P', 'BR', 'B', 'STRONG', 'U', 'SPAN', 'I', 'EM', 'UL', 'OL', 'LI', 'FONT']);
    function walk(parent) {
      for (const node of [...parent.children]) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH'].includes(node.tagName)) { node.remove(); continue; }
        walk(node);
        if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
        const style = node.style;
        const safe = {};
        for (const name of ['color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line']) {
          const value = style.getPropertyValue(name);
          if (value && !/url|var\(/i.test(value)) safe[name] = value;
        }
        const color = node.tagName === 'FONT' ? node.getAttribute('color') : null;
        for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
        for (const [name, value] of Object.entries(safe)) node.style.setProperty(name, value);
        if (color && CSS.supports('color', color)) node.style.color = color;
      }
    }
    walk(template.content);
    return template.innerHTML;
  }
  function snapshot() {
    return { date: $('date').innerHTML, subject: $('subject').innerHTML, writing: $('writing').innerHTML, dateManual, sizes: fields.map(el => el.style.fontSize) };
  }
  function apply(data) {
    dateManual = Boolean(data.dateManual);
    fields.forEach((field, i) => {
      field.innerHTML = clean(data[field.id]);
      const size = data.sizes?.[i];
      field.style.fontSize = /^\d+(\.\d+)?px$/.test(size || '') ? size : '';
    });
    if (!dateManual) $('date').textContent = today();
    selection = null;
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ current: snapshot(), previous }));
      status('Saved in this browser');
    } catch (_) {
      status('Saving unavailable — keep this tab open', true);
    }
    $('restore').disabled = !previous;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && saved.current) {
      apply(saved.current);
      previous = saved.previous || null;
    } else $('date').textContent = today();
  } catch (_) {
    $('date').textContent = today();
    status('Saved board unavailable', true);
  }
  save();
  function remember() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const field = fields.find(el => el.contains(range.startContainer) && el.contains(range.endContainer));
    if (field) {
      active = field;
      selection = range.cloneRange();
      $('bold').setAttribute('aria-pressed', String(document.queryCommandState('bold')));
      $('underline').setAttribute('aria-pressed', String(document.queryCommandState('underline')));
      const anchor = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
      const style = getComputedStyle(anchor);
      const size = String(Math.round(parseFloat(style.fontSize)));
      if ([...$('size').options].some(option => option.value === size)) $('size').value = size;
      const rgb = style.color.match(/\d+/g);
      if (rgb?.length >= 3) $('colour').value = '#' + rgb.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
    }
  }
  document.addEventListener('selectionchange', remember);
  function restoreSelection() {
    active.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (selection && active.contains(selection.startContainer) && active.contains(selection.endContainer)) sel.addRange(selection);
    else { const range = document.createRange(); range.selectNodeContents(active); range.collapse(false); sel.addRange(range); }
  }
  function format(command, value) {
    restoreSelection();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(command, false, value);
    if (active.id === 'date') dateManual = true;
    remember();
    save();
  }
  for (const name of ['bold', 'underline']) {
    $(name).addEventListener('mousedown', e => e.preventDefault());
    $(name).addEventListener('click', () => format(name));
  }
  document.querySelector('.tools').addEventListener('pointerdown', remember);
  $('colour').addEventListener('input', e => format('foreColor', e.target.value));
  $('colour').addEventListener('change', e => format('foreColor', e.target.value));
  $('size').addEventListener('change', e => {
    restoreSelection();
    const size = e.target.value;
    const range = window.getSelection().getRangeAt(0);
    if (range.collapsed) {
      // With no selection, resize this whole writing area, including future typing.
      active.style.fontSize = `${size}px`;
      active.querySelectorAll('[style]').forEach(el => el.style.removeProperty('font-size'));
    } else {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('fontSize', false, '7');
      active.querySelectorAll('font[size="7"]').forEach(el => { el.removeAttribute('size'); el.style.fontSize = `${size}px`; });
    }
    remember(); save();
  });
  fields.forEach(field => {
    field.addEventListener('focus', () => { active = field; });
    field.addEventListener('input', () => {
      if (field.id === 'date') dateManual = true;
      if (!field.textContent.trim() && !field.querySelector('img')) field.innerHTML = '';
      save();
    });
    field.addEventListener('paste', e => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
    if (field.id !== 'writing') field.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fields[fields.indexOf(field) + 1].focus(); } });
  });
  $('clear').addEventListener('click', () => $('clear-dialog').showModal());
  $('clear-dialog').querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    $('clear-dialog').close();
    if (event.submitter.value !== 'clear') return;
    // Repeated clears must not overwrite the recoverable board with an empty one.
    if ($('subject').textContent.trim() || $('writing').textContent.trim() || dateManual) previous = snapshot();
    apply({ date: '', subject: '', writing: '', dateManual: false });
    save(); $('writing').focus();
  });
  $('restore').addEventListener('click', () => $('restore-dialog').showModal());
  $('restore-dialog').querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    $('restore-dialog').close();
    if (event.submitter.value !== 'restore' || !previous) return;
    const current = snapshot(); apply(previous); previous = current; save();
  });
  function fullscreenLabel() {
    const on = Boolean(document.fullscreenElement || document.webkitFullscreenElement || fullScreenFallback);
    $('fullscreen').textContent = on ? 'Exit fullscreen' : 'Fullscreen';
    $('fullscreen').setAttribute('aria-pressed', String(on));
  }
  $('fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
      else if (document.documentElement.webkitRequestFullscreen) document.documentElement.webkitRequestFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else { fullScreenFallback = !fullScreenFallback; document.body.classList.toggle('presentation', fullScreenFallback); status('Use your browser’s fullscreen option for a full display'); }
      fullscreenLabel();
    } catch (_) { status('Use your browser’s fullscreen option', true); }
  });
  document.addEventListener('fullscreenchange', fullscreenLabel);
  document.addEventListener('webkitfullscreenchange', fullscreenLabel);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && fullScreenFallback) { fullScreenFallback = false; document.body.classList.remove('presentation'); fullscreenLabel(); } });
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  setInterval(() => { if (!dateManual && $('date').textContent !== today()) { $('date').textContent = today(); save(); } }, 60000);
})();
