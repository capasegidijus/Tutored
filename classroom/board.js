'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const fields = ['date', 'subject', 'writing'].map($);
  const KEY = 'classroom-board.v1';
  const today = () => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const freshBoard = () => ({ id: uid(), date: '', subject: '', writing: '', dateManual: false, sizes: ['', '', ''], strokes: [], shapes: [], boxes: [], activities: [], background: 'plain' });
  let boards = [], currentId = '', previous = null, active = $('writing'), selection = null;
  let mode = 'text', drawColor = '#202124', drawWidth = 6, activeStroke = null, activeShape = null, deleteTarget = '';
  let selectedBox = '', selectedShape = '', dragAction = null;
  let undoStack = [], redoStack = [], typingTimer = 0, typingBefore = null, lastSnapshot = null;
  let timer = { remaining: 300000, endsAt: 0, running: false }, timerHidden = true, timerEnded = false;
  let fullScreenFallback = false;
  const canvas = $('ink'), ctx = canvas.getContext('2d'), layer = $('object-layer');
  const current = () => boards.find(board => board.id === currentId) || boards[0];
  const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
  function clean(html) {
    const template = document.createElement('template'); template.innerHTML = typeof html === 'string' ? html : '';
    const allowed = new Set(['DIV', 'P', 'BR', 'B', 'STRONG', 'U', 'SPAN', 'I', 'EM', 'UL', 'OL', 'LI', 'FONT']);
    function walk(parent) {
      for (const node of [...parent.children]) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH'].includes(node.tagName)) { node.remove(); continue; }
        walk(node);
        if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
        const safe = {}, style = node.style;
        for (const name of ['color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'text-align']) {
          const value = style.getPropertyValue(name); if (value && !/url|var\(/i.test(value)) safe[name] = value;
        }
        const color = node.tagName === 'FONT' ? node.getAttribute('color') : null;
        for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
        for (const [name, value] of Object.entries(safe)) node.style.setProperty(name, value);
        if (color && CSS.supports('color', color)) node.style.color = color;
      }
    }
    walk(template.content); return template.innerHTML;
  }
  function normalizedStroke(source) {
    if (!source || !Array.isArray(source.points) || !source.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
    return { kind: source.kind === 'highlight' ? 'highlight' : 'pen', color: /^#[\da-f]{6}$/i.test(source.color) ? source.color : '#202124', width: Number.isFinite(source.width) ? Math.max(.001, Math.min(.06, source.width)) : .005, points: source.points.map(p => ({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) })) };
  }
  function normalizeShape(source) {
    if (!source || !['line', 'arrow', 'ellipse', 'rect'].includes(source.type)) return null;
    return { id: typeof source.id === 'string' ? source.id : uid(), type: source.type, color: /^#[\da-f]{6}$/i.test(source.color) ? source.color : '#202124', width: Number.isFinite(source.width) ? Math.max(.001, Math.min(.06, source.width)) : .005, x: Math.max(0, Math.min(1, Number(source.x) || 0)), y: Math.max(0, Math.min(1, Number(source.y) || 0)), w: Math.max(.001, Math.min(1, Math.abs(Number(source.w) || .001))), h: Math.max(.001, Math.min(1, Math.abs(Number(source.h) || .001))) };
  }
  function normalizeBox(source) {
    if (!source || typeof source !== 'object') return null;
    return { id: typeof source.id === 'string' ? source.id : uid(), html: clean(source.html), x: Math.max(0, Math.min(.98, Number(source.x) || 0)), y: Math.max(0, Math.min(.98, Number(source.y) || 0)), w: Math.max(.08, Math.min(1, Number(source.w) || .28)), h: Math.max(.06, Math.min(1, Number(source.h) || .2)) };
  }
  function normalizeActivity(source) {
    if (!source || !['words', 'sorting', 'numberline', 'random', 'fraction'].includes(source.type)) return null;
    const n = (v, fallback, min = 0, max = 1) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : fallback;
    const defaults = { words: [.55, .38], sorting: [.76, .5], numberline: [.76, .34], random: [.4, .38], fraction: [.62, .36] }[source.type]; const x = n(source.x, .08, 0, .78), y = n(source.y, .12, 0, .8); const legacySize = source.resized !== true && Number(source.w) === .55 && Number(source.h) === .3; const a = { id: typeof source.id === 'string' ? source.id : uid(), type: source.type, x, y, w: n(legacySize ? defaults[0] : source.w, defaults[0], .22, 1 - x), h: n(legacySize ? defaults[1] : source.h, defaults[1], .18, 1 - y), resized: Boolean(source.resized) };
    if (source.type === 'words') a.items = (Array.isArray(source.items) ? source.items : []).slice(0, 60).map((it, i) => ({ id: typeof it.id === 'string' ? it.id : uid(), text: String(it.text || '').slice(0, 120), x: n(it.x, .03 + (i % 4) * .23), y: n(it.y, .16 + Math.floor(i / 4) * .23) }));
    if (source.type === 'sorting') {
      a.categories = (Array.isArray(source.categories) ? source.categories : []).slice(0, 8).map(v => String(v).slice(0, 40));
      a.items = (Array.isArray(source.items) ? source.items : []).slice(0, 60).map((it, i) => ({ id: typeof it.id === 'string' ? it.id : uid(), text: String(it.text || '').slice(0, 100), category: Number.isInteger(it.category) && it.category >= 0 && it.category < a.categories.length ? it.category : -1, x: n(it.x, .02 + (i % 5) * .18), y: n(it.y, .6 + Math.floor(i / 5) * .12) }));
    }
    if (source.type === 'numberline') { a.min = n(source.min, 0, -10000, 10000); a.max = n(source.max, 20, -10000, 10000); a.step = n(source.step, 1, .001, 10000); a.marker = Math.round(n(source.marker, 0, 0, Math.max(0, (a.max - a.min) / a.step))); a.labels = source.labels !== false; }
    if (source.type === 'random') { a.min = Math.round(n(source.min, 1, -1000000, 1000000)); a.max = Math.round(n(source.max, 100, -1000000, 1000000)); a.two = Boolean(source.two); a.result = Array.isArray(source.result) ? source.result.slice(0, 2).map(v => Math.round(n(v, a.min, -1000000, 1000000))) : [a.min]; }
    if (source.type === 'fraction') { a.denominator = [2, 3, 4, 5, 6, 8, 10].includes(source.denominator) ? source.denominator : 4; a.shaded = Array.isArray(source.shaded) ? Array.from({ length: a.denominator }, (_, i) => Boolean(source.shaded[i])) : Array(a.denominator).fill(false); }
    return a;
  }
  function capture(board = current()) {
    if (!board) return null;
    if (board.id === currentId) saveCurrent();
    return { date: board.date, subject: board.subject, writing: board.writing, dateManual: board.dateManual, sizes: board.sizes.slice(), strokes: structuredClone(board.strokes), shapes: structuredClone(board.shapes), boxes: structuredClone(board.boxes), activities: structuredClone(board.activities || []), background: board.background };
  }
  function setSnapshot(board, data) {
    board.date = clean(data.date); board.subject = clean(data.subject); board.writing = clean(data.writing);
    board.dateManual = Boolean(data.dateManual);
    board.sizes = Array.isArray(data.sizes) ? data.sizes.map(size => /^\d+(\.\d+)?px$/.test(size || '') ? size : '') : ['', '', ''];
    board.strokes = Array.isArray(data.strokes) ? data.strokes.map(normalizedStroke).filter(Boolean) : [];
    board.shapes = Array.isArray(data.shapes) ? data.shapes.map(normalizeShape).filter(Boolean) : [];
    board.boxes = Array.isArray(data.boxes) ? data.boxes.map(normalizeBox).filter(Boolean) : [];
    board.activities = Array.isArray(data.activities) ? data.activities.map(normalizeActivity).filter(Boolean) : [];
    board.background = ['plain', 'lines', 'grid', 'dots'].includes(data.background) ? data.background : 'plain';
  }
  function saveCurrent() {
    const board = current(); if (!board) return;
    board.date = $('date').innerHTML; board.subject = $('subject').innerHTML; board.writing = $('writing').innerHTML;
    board.sizes = fields.map(field => field.style.fontSize);
    board.boxes = [...layer.querySelectorAll('.text-box')].map(el => ({ id: el.dataset.id, html: el.querySelector('.box-content').innerHTML, x: parseFloat(el.style.left) / 100, y: parseFloat(el.style.top) / 100, w: parseFloat(el.style.width) / 100, h: parseFloat(el.style.height) / 100 }));
  }
  function save() {
    saveCurrent();
    try { localStorage.setItem(KEY, JSON.stringify({ version: 4, boards, currentId, previous, timer, timerHidden, timerSound: $('timer-sound').checked })); status('Saved in this browser'); }
    catch (_) { status('Saving unavailable — keep this tab open', true); }
    $('restore').disabled = !previous;
    $('undo').disabled = !undoStack.some(item => item.boardId === currentId);
    $('redo').disabled = !redoStack.some(item => item.boardId === currentId);
  }
  function historyPush(state = capture()) { if (!state) return; undoStack.push({ boardId: currentId, state }); if (undoStack.length > 100) undoStack.shift(); redoStack = []; }
  function pathShape(shape, width, height) {
    const x = shape.x * width, y = shape.y * height, w = shape.w * width, h = shape.h * height;
    ctx.beginPath();
    if (shape.type === 'rect') ctx.rect(x, y, w, h);
    else if (shape.type === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
    else {
      ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
      if (shape.type === 'arrow') {
        const angle = Math.atan2(h, w), head = Math.max(12, shape.width * width * 3);
        ctx.moveTo(x + w, y + h); ctx.lineTo(x + w - head * Math.cos(angle - .48), y + h - head * Math.sin(angle - .48));
        ctx.moveTo(x + w, y + h); ctx.lineTo(x + w - head * Math.cos(angle + .48), y + h - head * Math.sin(angle + .48));
      }
    }
  }
  function renderCanvas() {
    const rect = $('board').getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio)); canvas.height = Math.max(1, Math.round(rect.height * ratio));
    canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const board = current(), w = rect.width, h = rect.height;
    for (const stroke of board?.strokes || []) {
      ctx.globalAlpha = stroke.kind === 'highlight' ? .32 : 1; ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width * w; ctx.beginPath();
      stroke.points.forEach((point, i) => { const x = point.x * w, y = point.y * h; if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      const first = stroke.points[0]; if (stroke.points.length === 1) { ctx.moveTo(first.x * w, first.y * h); ctx.lineTo(first.x * w + .1, first.y * h + .1); } ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const shape of board?.shapes || []) { ctx.strokeStyle = shape.color; ctx.lineWidth = shape.width * w; pathShape(shape, w, h); ctx.stroke(); }
    if (activeStroke) { ctx.globalAlpha = activeStroke.kind === 'highlight' ? .32 : 1; ctx.strokeStyle = activeStroke.color; ctx.lineWidth = activeStroke.width * w; ctx.beginPath(); activeStroke.points.forEach((p, i) => i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)); ctx.stroke(); ctx.globalAlpha = 1; }
    if (activeShape) { ctx.strokeStyle = activeShape.color; ctx.lineWidth = activeShape.width * w; pathShape(activeShape, w, h); ctx.stroke(); }
  }
  const resizeObserver = new ResizeObserver(() => { renderCanvas(); renderBoxes(); }); resizeObserver.observe($('board'));
  window.addEventListener('resize', () => { renderCanvas(); renderBoxes(); });
  function boxNode(box) {
    const el = document.createElement('section'); el.className = 'text-box'; el.dataset.id = box.id;
    el.style.left = `${box.x * 100}%`; el.style.top = `${box.y * 100}%`; el.style.width = `${box.w * 100}%`; el.style.height = `${box.h * 100}%`;
    const grip = document.createElement('button'); grip.type = 'button'; grip.className = 'box-grip'; grip.setAttribute('aria-label', 'Drag text box'); grip.title = 'Select and drag';
    const content = document.createElement('div'); content.className = 'box-content'; content.contentEditable = String(mode === 'text'); content.setAttribute('role', 'textbox'); content.setAttribute('aria-label', 'Moveable text box'); content.setAttribute('aria-multiline', 'true'); content.spellcheck = true; content.innerHTML = clean(box.html);
    const del = document.createElement('button'); del.type = 'button'; del.className = 'box-delete'; del.textContent = '×'; del.title = 'Delete text box'; del.setAttribute('aria-label', 'Delete text box');
    const resize = document.createElement('button'); resize.type = 'button'; resize.className = 'box-resize'; resize.title = 'Resize text box'; resize.setAttribute('aria-label', 'Resize text box');
    el.append(grip, content, del, resize); layer.append(el);
    content.addEventListener('focus', () => { if (mode === 'text') active = content; });
    content.addEventListener('input', () => { if (!typingTimer) typingBefore = lastSnapshot || capture(); clearTimeout(typingTimer); typingTimer = setTimeout(finishTyping, 450); save(); });
    content.addEventListener('paste', event => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); });
    grip.addEventListener('pointerdown', event => beginBoxDrag(event, el, 'move'));
    resize.addEventListener('pointerdown', event => beginBoxDrag(event, el, 'resize'));
    el.addEventListener('pointerdown', event => { if (mode === 'select' && event.target === content) beginBoxDrag(event, el, 'move'); });
    del.addEventListener('click', () => { historyPush(); current().boxes = current().boxes.filter(item => item.id !== box.id); selectedBox = ''; renderBoxes(); save(); });
    el.addEventListener('click', () => { if (mode === 'select') { selectedBox = box.id; selectedShape = ''; updateSelection(); } });
    return el;
  }
  function renderBoxes() {
    if (!layer) return;
    const currentNodes = new Map([...layer.querySelectorAll('.text-box')].map(el => [el.dataset.id, el]));
    const data = current()?.boxes || [];
    if (data.length !== currentNodes.size || data.some(item => !currentNodes.has(item.id))) { layer.querySelectorAll('.text-box,.shape-selection').forEach(node => node.remove()); data.forEach(box => boxNode(box)); }
    for (const box of data) {
      const el = layer.querySelector(`[data-id="${CSS.escape(box.id)}"]`); if (!el) continue;
      el.style.left = `${box.x * 100}%`; el.style.top = `${box.y * 100}%`; el.style.width = `${box.w * 100}%`; el.style.height = `${box.h * 100}%`;
      el.classList.toggle('selected', box.id === selectedBox); el.querySelector('.box-content').contentEditable = String(mode === 'text');
    }
    updateSelection();
  }
  function addText(parent, tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; node.textContent = value; parent.append(node); return node; }
  function renderActivities() {
    layer.querySelectorAll('.activity').forEach(node => node.remove());
    for (const raw of current()?.activities || []) {
      const a = normalizeActivity(raw); if (!a) continue; Object.assign(raw, a);
      const el = document.createElement('section'); el.className = `activity activity-${a.type}`; el.dataset.activityId = a.id;
      el.style.left = `${a.x * 100}%`; el.style.top = `${a.y * 100}%`;
      const head = document.createElement('header'); head.className = 'activity-titlebar'; head.dataset.moveHandle = 'true'; addText(head, 'strong', 'activity-title', ({ words:'Movable Words', sorting:'Sorting', numberline:'Number Line', random:'Random Numbers', fraction:'Fraction Bars' })[a.type]);
      const remove = addText(head, 'button', 'activity-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove activity'); remove.title = 'Remove activity'; el.append(head);
      if (a.type === 'words') {
        const tray = document.createElement('div'); tray.className = 'word-tray'; tray.style.minHeight = `${Math.max(120, Math.ceil(a.items.length / 4) * 50)}px`;
        a.items.forEach(item => { const card = addText(tray, 'button', 'word-card', item.text); card.type = 'button'; card.dataset.itemId = item.id; card.style.left = `${item.x * 100}%`; card.style.top = `${item.y * 100}%`; const del = addText(card, 'span', 'card-remove', '×'); del.setAttribute('aria-label', 'Delete word'); }); el.append(tray);
        const shuffle = addText(el, 'button', 'activity-action', 'Shuffle'); shuffle.type = 'button'; shuffle.dataset.action = 'shuffle';
      }
      if (a.type === 'sorting') {
        const sortArea = document.createElement('div'); sortArea.className = 'sort-area'; sortArea.style.setProperty('--sort-cols', a.categories.length);
        a.categories.forEach((name, index) => { const lane = addText(sortArea, 'div', 'sort-lane', name); lane.dataset.category = String(index); });
        const cards = document.createElement('div'); cards.className = 'sort-cards'; a.items.forEach(item => { const card = addText(cards, 'button', 'sort-card', item.text); card.type = 'button'; card.dataset.itemId = item.id; card.style.left = `${item.x * 100}%`; card.style.top = `${item.y * 100}%`; }); el.append(sortArea, cards);
        const reset = addText(el, 'button', 'activity-action', 'Reset'); reset.type = 'button'; reset.dataset.action = 'reset';
      }
      if (a.type === 'numberline') {
        const total = Math.round((a.max - a.min) / a.step), line = document.createElement('div'); line.className = 'number-track'; line.dataset.activityId = a.id;
        for (let i = 0; i <= total; i++) { const tick = document.createElement('i'); tick.className = 'number-tick'; tick.style.left = `${total ? i / total * 100 : 0}%`; line.append(tick); if (a.labels) { const label = addText(line, 'span', 'number-label', String(a.min + i * a.step)); label.style.left = `${total ? i / total * 100 : 0}%`; } }
        const marker = addText(line, 'button', 'number-marker', String(a.min + a.marker * a.step)); marker.type = 'button'; marker.dataset.marker = 'true'; marker.style.left = `${total ? a.marker / total * 100 : 0}%`; marker.setAttribute('aria-label', `Marker at ${a.min + a.marker * a.step}`); el.append(line);
        const foot = document.createElement('footer'); addText(foot, 'span', 'number-range', `${a.min} to ${a.max} · every ${a.step}`); const toggle = addText(foot, 'button', 'activity-action', a.labels ? 'Hide labels' : 'Show labels'); toggle.type = 'button'; toggle.dataset.action = 'labels'; el.append(foot);
      }
      if (a.type === 'random') {
        const bounds = addText(el, 'p', 'random-bounds', `From ${a.min} to ${a.max}${a.two ? ' · two numbers' : ''}`); bounds.setAttribute('aria-label','Selected number range');
        const results = addText(el, 'div', 'random-results', ''); a.result.forEach(value => addText(results, 'strong', '', String(value)));
        const generate = addText(el, 'button', 'activity-action', 'Generate'); generate.type = 'button'; generate.dataset.action = 'generate';
      }
      if (a.type === 'fraction') {
        const bar = document.createElement('div'); bar.className = 'fraction-bar';
        a.shaded.forEach((shaded, index) => { const cell = addText(bar, 'button', `fraction-cell${shaded ? ' shaded' : ''}`, ''); cell.type = 'button'; cell.dataset.cell = String(index); cell.setAttribute('aria-label', `${shaded ? 'Unshade' : 'Shade'} part ${index + 1} of ${a.denominator}`); });
        addText(el, 'div', 'fraction-count', `${a.shaded.filter(Boolean).length}/${a.denominator}`); el.append(bar);
      }
      const resize = addText(el, 'button', 'activity-resize', ''); resize.type = 'button'; resize.setAttribute('aria-label', 'Resize activity'); resize.title = 'Drag to resize'; remove.addEventListener('pointerdown', event => { event.stopPropagation(); }); remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); historyPush(); current().activities = current().activities.filter(item => item.id !== a.id); renderActivities(); save(); lastSnapshot = capture(); }); resize.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); historyPush(); dragAction = { type: 'activity-resize', id: a.id, start: { x: event.clientX, y: event.clientY }, before: { w: a.w, h: a.h } }; resize.setPointerCapture?.(event.pointerId); });
      el.addEventListener('pointerdown', event => {
        if (mode === 'pen' || mode === 'highlight' || mode === 'eraser' || mode === 'shape' || event.target.closest('.activity-remove,.card-remove')) return;
        const card = event.target.closest('.word-card,.sort-card');
        const track = event.target.closest('.number-track');
        if (card) {
          event.preventDefault(); event.stopPropagation(); const item = a.items.find(row => row.id === card.dataset.itemId); if (!item) return;
          historyPush(); dragAction = { type: 'activity-card', id: a.id, itemId: item.id, start: { x: event.clientX, y: event.clientY }, before: { x: item.x, y: item.y }, size: { w: card.parentElement.clientWidth, h: card.parentElement.clientHeight } }; card.setPointerCapture?.(event.pointerId); return;
        }
        if (track) {
          event.preventDefault(); event.stopPropagation(); const rect = track.getBoundingClientRect(), total = Math.round((a.max - a.min) / a.step); historyPush(); a.marker = Math.max(0, Math.min(total, Math.round((event.clientX - rect.left) / rect.width * total))); const marker = track.querySelector('.number-marker'); marker.style.left = `${total ? a.marker / total * 100 : 0}%`; marker.textContent = String(a.min + a.marker * a.step); marker.setAttribute('aria-label', `Marker at ${marker.textContent}`); dragAction = { type: 'activity-marker', id: a.id, total }; track.setPointerCapture?.(event.pointerId); save(); return;
        }
        if (event.target.closest('[data-move-handle]')) {
          event.preventDefault(); event.stopPropagation(); historyPush(); dragAction = { type: 'activity-move', id: a.id, start: { x: event.clientX, y: event.clientY }, before: { x: a.x, y: a.y } }; head.setPointerCapture?.(event.pointerId);
        }
      });
      el.addEventListener('click', event => {
        const itemDelete = event.target.closest('.card-remove'); if (itemDelete) { const card = itemDelete.closest('.word-card'); historyPush(); a.items = a.items.filter(item => item.id !== card.dataset.itemId); renderActivities(); save(); lastSnapshot = capture(); return; }
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'shuffle') { historyPush(); a.items.forEach(item => { item.x = Math.random() * .78; item.y = Math.random() * .72; }); renderActivities(); save(); lastSnapshot = capture(); }
        if (action === 'reset') { historyPush(); a.items.forEach((item, i) => { item.category = -1; item.x = .02 + (i % 5) * .19; item.y = Math.min(.95, .78 + Math.floor(i / 5) * .11); }); renderActivities(); save(); lastSnapshot = capture(); }
        if (action === 'labels') { historyPush(); a.labels = !a.labels; renderActivities(); save(); lastSnapshot = capture(); }
        if (action === 'generate') { historyPush(); a.result = Array.from({ length: a.two ? 2 : 1 }, () => Math.floor(Math.random() * (a.max - a.min + 1)) + a.min); renderActivities(); save(); lastSnapshot = capture(); }
        if (event.target.matches('.fraction-cell')) { historyPush(); const i = Number(event.target.dataset.cell); a.shaded[i] = !a.shaded[i]; renderActivities(); save(); lastSnapshot = capture(); }
      });
      layer.append(el);
    }
  }
  const activityDialog = $('activity-dialog'); let activityType = '';
  function openActivityForm(type) {
    activityType = type; $('activity-error').textContent = ''; $('activity-title').textContent = ({words:'Movable Words',sorting:'Sorting',numberline:'Number Line',random:'Random Numbers',fraction:'Fraction Bars'})[type];
    const fieldsBox = $('activity-fields');
    const input = (id, label, value, attrs = '') => `<label class="activity-field">${label}<input id="${id}" value="${value}" ${attrs}></label>`;
    if (type === 'words') fieldsBox.innerHTML = `<label class="activity-field">Words or sentence<textarea id="activity-text" rows="3" placeholder="The little boy walked to school."></textarea></label><label class="activity-field">Cards<select id="activity-split"><option value="word">One card per word</option><option value="sentence">One card per sentence</option></select></label>`;
    if (type === 'sorting') fieldsBox.innerHTML = `<label class="activity-field">Categories (separate with commas)<input id="activity-categories" value="Nouns, Verbs, Adjectives"></label><label class="activity-field">Sentence or words<textarea id="activity-items" rows="3" placeholder="The curious fox found a hidden den."></textarea><p class="activity-hint">Each word becomes its own card. Punctuation stays with the word.</p></label>`;
    if (type === 'numberline') fieldsBox.innerHTML = input('activity-min','Minimum','0','type="number"')+input('activity-max','Maximum','20','type="number"')+input('activity-step','Interval','1','type="number" min="0.001" step="any"')+`<label class="activity-field inline"><input id="activity-labels" type="checkbox" checked> Show number labels</label>`;
    if (type === 'random') fieldsBox.innerHTML = input('activity-min','Minimum','1','type="number"')+input('activity-max','Maximum','100','type="number"')+`<label class="activity-field inline"><input id="activity-two" type="checkbox"> Generate two numbers</label>`;
    if (type === 'fraction') fieldsBox.innerHTML = `<label class="activity-field">Equal parts<select id="activity-denominator">${[2,3,4,5,6,8,10].map(n=>`<option value="${n}" ${n===4?'selected':''}>${n} equal parts</option>`).join('')}</select></label>`;
    activityDialog.showModal();
  }
  $('activity-cancel').addEventListener('click', () => activityDialog.close());
  document.querySelectorAll('[data-activity]').forEach(button => button.addEventListener('click', () => { $('activities-menu').open = false; openActivityForm(button.dataset.activity); }));
  $('activity-form').addEventListener('submit', event => {
    event.preventDefault(); $('activity-error').textContent = '';
    const activities = current().activities; const initialSize = { words: [.55, .38], sorting: [.76, .5], numberline: [.76, .34], random: [.4, .38], fraction: [.62, .36] }[activityType]; const a = { id: uid(), type: activityType, x: .08 + Math.min(.12, activities.length * .025), y: .12 + Math.min(.18, activities.length * .035), w: initialSize[0], h: initialSize[1] };
    const csv = value => value.split(',').map(item => item.trim()).filter(Boolean);
    if (activityType === 'words') {
      const value = $('activity-text').value.trim(); if (!value) { $('activity-error').textContent = 'Enter a word or sentence first.'; return; }
      const entries = $('activity-split').value === 'sentence' ? value.split(/[.!?]+/).map(s => s.trim()).filter(Boolean) : value.split(/\s+/).filter(Boolean);
      const rows = Math.max(1, Math.ceil(entries.length / 4)); a.items = entries.map((text, i) => ({ id: uid(), text, x: .02 + (i % 4) * .24, y: Math.min(.92, .02 + Math.floor(i / 4) * .96 / rows) }));
    }
    if (activityType === 'sorting') {
      a.categories = csv($('activity-categories').value).slice(0, 8); const items = $('activity-items').value.trim().split(/\s+/).filter(Boolean).slice(0, 60);
      if (a.categories.length < 2 || !items.length) { $('activity-error').textContent = 'Add at least two categories and one card.'; return; }
      a.type = 'sorting'; a.items = items.map((text, i) => ({ id: uid(), text, category: -1, x: .02 + (i % 5) * .19, y: Math.min(.95, .78 + Math.floor(i / 5) * .11) }));
    }
    if (activityType === 'numberline') {
      a.min = Number($('activity-min').value); a.max = Number($('activity-max').value); a.step = Number($('activity-step').value); a.labels = $('activity-labels').checked; a.marker = 0;
      const count = (a.max - a.min) / a.step;
      if (![a.min,a.max,a.step].every(Number.isFinite) || a.max <= a.min || a.step <= 0 || Math.abs(count - Math.round(count)) > 1e-8 || count > 40) { $('activity-error').textContent = 'Use a larger maximum than minimum, an interval that fits exactly, and no more than 40 steps.'; return; }
    }
    if (activityType === 'random') {
      a.min = Number($('activity-min').value); a.max = Number($('activity-max').value); a.two = $('activity-two').checked;
      if (![a.min,a.max].every(Number.isSafeInteger) || a.max < a.min) { $('activity-error').textContent = 'Enter whole numbers and make sure the maximum is at least the minimum.'; return; }
      a.result = Array.from({ length: a.two ? 2 : 1 }, () => Math.floor(Math.random() * (a.max - a.min + 1)) + a.min);
    }
    if (activityType === 'fraction') { a.denominator = Number($('activity-denominator').value); a.shaded = Array(a.denominator).fill(false); }
    historyPush(); activities.push(normalizeActivity(a)); renderActivities(); save(); lastSnapshot = capture(); activityDialog.close();
  });
  function updateSelection() {
    layer.querySelectorAll('.text-box').forEach(el => el.classList.toggle('selected', el.dataset.id === selectedBox));
    let outline = layer.querySelector('.shape-selection');
    const shape = current()?.shapes.find(item => item.id === selectedShape);
    if (!shape || mode !== 'select') { outline?.remove(); return; }
    if (!outline) {
      outline = document.createElement('div'); outline.className = 'shape-selection';
      const resize = document.createElement('button'); resize.type = 'button'; resize.className = 'box-resize'; resize.setAttribute('aria-label', 'Resize selected shape');
      resize.addEventListener('pointerdown', event => { const selected = current()?.shapes.find(item => item.id === selectedShape); if (selected) beginShapeDrag(event, selected, 'resize'); });
      outline.append(resize); layer.append(outline);
    }
    outline.style.left = `${shape.x * 100}%`; outline.style.top = `${shape.y * 100}%`; outline.style.width = `${shape.w * 100}%`; outline.style.height = `${shape.h * 100}%`;
  }
  function renderTabs() {
    const nav = $('board-tabs'); nav.replaceChildren();
    boards.forEach((board, index) => {
      const group = document.createElement('div'); group.className = 'board-tab-group'; group.setAttribute('aria-current', String(board.id === currentId));
      const tab = document.createElement('button'); tab.className = 'board-tab'; tab.type = 'button'; tab.setAttribute('aria-label', `Board ${index + 1}`); tab.textContent = String(index + 1); tab.addEventListener('click', () => { if (board.id !== currentId) applyBoard(board.id); });
      const copy = document.createElement('button'); copy.className = 'duplicate-tab'; copy.type = 'button'; copy.textContent = '⧉'; copy.title = `Duplicate board ${index + 1}`; copy.setAttribute('aria-label', `Duplicate board ${index + 1}`); copy.addEventListener('click', () => duplicateBoard(board));
      group.append(tab, copy);
      if (boards.length > 1) { const remove = document.createElement('button'); remove.className = 'remove-tab'; remove.type = 'button'; remove.textContent = '×'; remove.title = `Delete board ${index + 1}`; remove.setAttribute('aria-label', `Delete board ${index + 1}`); remove.addEventListener('click', () => { deleteTarget = board.id; $('delete-dialog').showModal(); }); group.append(remove); }
      nav.append(group);
    });
    const add = document.createElement('button'); add.type = 'button'; add.className = 'add-board'; add.textContent = '+'; add.setAttribute('aria-label', 'Add a board'); add.title = 'Add a board'; add.addEventListener('click', () => { const board = makeBlankBoard(); boards.push(board); applyBoard(board.id); }); nav.append(add);
  }
  function duplicateBoard(board) {
    if (board.id === currentId) saveCurrent();
    const copy = structuredClone(board); copy.id = uid();
    if (board.id === currentId) { const live = capture(board); setSnapshot(copy, live); }
    boards.splice(boards.findIndex(item => item.id === board.id) + 1, 0, copy); applyBoard(copy.id);
  }
  function applyBoard(id) {
    clearTimeout(typingTimer); typingTimer = 0; typingBefore = null; saveCurrent(); currentId = id;
    const board = current(); if (!board) return;
    fields.forEach((field, i) => { field.innerHTML = clean(board[field.id]); field.style.fontSize = board.sizes[i] || ''; });
    if (!board.dateManual) $('date').textContent = today();
    $('board').className = `background-${board.background}`; $('background').value = board.background;
    selection = null; active = $('writing'); selectedBox = ''; selectedShape = ''; renderBoxes(); renderActivities(); renderCanvas(); renderTabs(); lastSnapshot = capture(); save();
  }
  function makeBlankBoard() { const board = freshBoard(); board.date = today(); return board; }
  function finishTyping() { clearTimeout(typingTimer); typingTimer = 0; if (typingBefore) historyPush(typingBefore); typingBefore = null; lastSnapshot = capture(); save(); }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved?.version >= 2 && Array.isArray(saved.boards) && saved.boards.length) {
      boards = saved.boards.map(source => { const board = { ...freshBoard(), id: typeof source.id === 'string' ? source.id : uid() }; setSnapshot(board, source); return board; });
      currentId = boards.some(board => board.id === saved.currentId) ? saved.currentId : boards[0].id; previous = saved.previous || null;
      if (saved.timer && Number.isFinite(saved.timer.remaining)) timer = { remaining: Math.max(0, saved.timer.remaining), endsAt: Number(saved.timer.endsAt) || 0, running: Boolean(saved.timer.running) };
      timerHidden = saved.timerHidden !== false; $('timer-sound').checked = Boolean(saved.timerSound);
    } else if (saved?.current) { const board = makeBlankBoard(); setSnapshot(board, saved.current); boards = [board]; currentId = board.id; previous = saved.previous || null; }
    else { const board = makeBlankBoard(); boards = [board]; currentId = board.id; }
  } catch (_) { const board = makeBlankBoard(); boards = [board]; currentId = board.id; status('Saved board unavailable', true); }
  function loadActive() {
    const board = current(); fields.forEach((field, i) => { field.innerHTML = clean(board[field.id]); field.style.fontSize = board.sizes[i] || ''; });
    if (!board.dateManual) $('date').textContent = today();
    $('board').className = `background-${board.background}`; $('background').value = board.background;
    renderTabs(); renderBoxes(); renderActivities(); renderCanvas(); lastSnapshot = capture();
  }
  loadActive();
  function remember() {
    const sel = window.getSelection(); if (!sel.rangeCount) return; const range = sel.getRangeAt(0);
    const editables = [...fields, ...layer.querySelectorAll('.box-content')];
    const field = editables.find(el => el.contains(range.startContainer) && el.contains(range.endContainer));
    if (field) { active = field; selection = range.cloneRange(); $('bold').setAttribute('aria-pressed', String(document.queryCommandState('bold'))); $('underline').setAttribute('aria-pressed', String(document.queryCommandState('underline'))); }
  }
  document.addEventListener('selectionchange', remember);
  function restoreSelection() { active.focus(); const sel = window.getSelection(); sel.removeAllRanges(); if (selection && active.contains(selection.startContainer) && active.contains(selection.endContainer)) sel.addRange(selection); else { const range = document.createRange(); range.selectNodeContents(active); range.collapse(false); sel.addRange(range); } }
  function format(command, value = null) {
    if (mode !== 'text') setMode('text'); historyPush(); restoreSelection(); document.execCommand('styleWithCSS', false, true); document.execCommand(command, false, value);
    if (active.id === 'date') current().dateManual = true;
    remember(); lastSnapshot = capture(); save();
  }
  for (const name of ['bold', 'underline']) { $(name).addEventListener('mousedown', event => event.preventDefault()); $(name).addEventListener('click', () => format(name)); }
  $('text-tools').addEventListener('pointerdown', remember);
  $('colour').addEventListener('input', event => format('foreColor', event.target.value)); $('colour').addEventListener('change', event => format('foreColor', event.target.value));
  $('size').addEventListener('change', event => { historyPush(); restoreSelection(); const size = event.target.value, range = window.getSelection().getRangeAt(0); if (range.collapsed) active.style.fontSize = `${size}px`; else { document.execCommand('styleWithCSS', false, false); document.execCommand('fontSize', false, '7'); active.querySelectorAll('font[size="7"]').forEach(el => { el.removeAttribute('size'); el.style.fontSize = `${size}px`; }); } remember(); lastSnapshot = capture(); save(); });
  $('alignment').addEventListener('change', event => { const value = event.target.value; format(value === 'center' ? 'justifyCenter' : value === 'right' ? 'justifyRight' : 'justifyLeft'); event.target.value = 'left'; });
  $('list-format').addEventListener('change', event => { if (event.target.value) format(event.target.value === 'bullet' ? 'insertUnorderedList' : 'insertOrderedList'); event.target.value = ''; });
  function queueTyping(field) { if (!typingTimer) typingBefore = lastSnapshot || capture(); clearTimeout(typingTimer); typingTimer = setTimeout(finishTyping, 450); save(); }
  fields.forEach(field => {
    field.addEventListener('focus', () => { if (mode === 'text') active = field; });
    field.addEventListener('input', () => { if (field.id === 'date') current().dateManual = true; queueTyping(field); });
    field.addEventListener('paste', event => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); });
    if (field.id !== 'writing') field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); fields[fields.indexOf(field) + 1].focus(); } });
  });
  function setMode(next) {
    mode = next; $('mode').value = mode;
    for (const name of ['pen', 'eraser']) document.body.classList.toggle(`mode-${name}`, mode === name);
    fields.forEach(field => field.contentEditable = String(mode === 'text'));
    document.body.dataset.mode = mode;
    $('text-tools').hidden = mode !== 'text'; $('draw-tools').hidden = !['pen', 'highlight', 'shape'].includes(mode); $('shape-tools').hidden = mode !== 'shape';
    const select = $('draw-colour'); select.replaceChildren();
    const colors = mode === 'highlight' ? [['#facc15', 'Yellow'], ['#22c55e', 'Green'], ['#ec4899', 'Pink'], ['#38bdf8', 'Blue']] : [['#202124', 'Black'], ['#2563eb', 'Blue'], ['#dc2626', 'Red'], ['#15803d', 'Green']];
    colors.forEach(([value, label]) => { const option = new Option(label, value); select.append(option); });
    select.value = colors.some(([value]) => value === drawColor) ? drawColor : colors[0][0]; drawColor = select.value;
    if (mode === 'text') active.focus(); renderBoxes(); renderCanvas();
  }
  $('mode').addEventListener('change', event => setMode(event.target.value));
  $('draw-colour').addEventListener('change', event => { drawColor = event.target.value; }); $('draw-width').addEventListener('change', event => { drawWidth = Number(event.target.value); });
  function point(event) { const rect = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }; }
  function pointDistance(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy, t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0; return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)); }
  function boxAt(pointValue) { const rect = $('board').getBoundingClientRect(); return { x: pointValue.x * rect.width, y: pointValue.y * rect.height }; }
  function beginBoxDrag(event, el, action) {
    if (mode !== 'select') return; event.preventDefault(); event.stopPropagation(); selectedBox = el.dataset.id; selectedShape = ''; updateSelection();
    const box = current().boxes.find(item => item.id === selectedBox), p = boxAt(point(event)); historyPush(); dragAction = { type: 'box', action, id: box.id, start: p, before: structuredClone(box) }; el.setPointerCapture?.(event.pointerId);
  }
  function beginShapeDrag(event, shape, action) { event.preventDefault(); event.stopPropagation(); selectedShape = shape.id; selectedBox = ''; if (action === 'resize') historyPush(); event.currentTarget.setPointerCapture?.(event.pointerId); dragAction = { type: 'shape', action, id: shape.id, start: boxAt(point(event)), before: structuredClone(shape) }; }
  canvas.addEventListener('pointerdown', event => {
    if (mode === 'text') return; event.preventDefault(); canvas.setPointerCapture(event.pointerId); const p = point(event);
    if (mode === 'box') { const box = { id: uid(), html: '', x: p.x, y: p.y, w: .28, h: .2 }; historyPush(); current().boxes.push(box); selectedBox = box.id; selectedShape = ''; renderBoxes(); setMode('text'); const editor = layer.querySelector(`[data-id="${CSS.escape(box.id)}"] .box-content`); editor?.focus(); save(); lastSnapshot = capture(); return; }
    if (mode === 'select') {
      const hit = [...current().shapes].reverse().find(shape => p.x >= shape.x - .02 && p.x <= shape.x + shape.w + .02 && p.y >= shape.y - .02 && p.y <= shape.y + shape.h + .02);
      selectedShape = hit?.id || ''; selectedBox = ''; updateSelection();
      if (hit) { historyPush(); dragAction = { type: 'shape', action: 'move', id: hit.id, start: boxAt(p), before: structuredClone(hit) }; }
      return;
    }
    if (mode === 'shape') { historyPush(); activeShape = { id: uid(), type: $('shape-type').value, color: drawColor, width: drawWidth / canvas.clientWidth, x: p.x, y: p.y, w: .001, h: .001 }; renderCanvas(); return; }
    historyPush();
    if (mode === 'pen' || mode === 'highlight') { activeStroke = { kind: mode === 'highlight' ? 'highlight' : 'pen', color: drawColor, width: drawWidth / canvas.clientWidth, points: [p] }; current().strokes.push(activeStroke); }
    else if (mode === 'eraser') { const radius = drawWidth * 2 / canvas.clientWidth; current().strokes = current().strokes.filter(stroke => !stroke.points.some((q, i) => i ? pointDistance(p, stroke.points[i - 1], q) < radius : Math.hypot(p.x - q.x, p.y - q.y) < radius)); }
    renderCanvas();
  });
  canvas.addEventListener('pointermove', event => {
    const p = point(event);
    if (dragAction) {
      const rect = $('board').getBoundingClientRect(), dx = (event.clientX - (canvas.getBoundingClientRect().left + dragAction.start.x)) / rect.width, dy = (event.clientY - (canvas.getBoundingClientRect().top + dragAction.start.y)) / rect.height;
      if (dragAction.type === 'shape') { const shape = current().shapes.find(item => item.id === dragAction.id); if (shape) { if (dragAction.action === 'move') { shape.x = Math.max(0, Math.min(1 - shape.w, dragAction.before.x + dx)); shape.y = Math.max(0, Math.min(1 - shape.h, dragAction.before.y + dy)); } else { shape.w = Math.max(.01, Math.min(1 - dragAction.before.x, dragAction.before.w + dx)); shape.h = Math.max(.01, Math.min(1 - dragAction.before.y, dragAction.before.h + dy)); } renderCanvas(); updateSelection(); } }
      return;
    }
    if (activeStroke && canvas.hasPointerCapture(event.pointerId)) { event.preventDefault(); activeStroke.points.push(p); renderCanvas(); }
    if (activeShape && canvas.hasPointerCapture(event.pointerId)) { event.preventDefault(); activeShape.w = p.x - activeShape.x; activeShape.h = p.y - activeShape.y; if (activeShape.w < 0) { activeShape.x = p.x; activeShape.w = Math.abs(activeShape.w); } if (activeShape.h < 0) { activeShape.y = p.y; activeShape.h = Math.abs(activeShape.h); } renderCanvas(); }
    if (['pen', 'highlight', 'eraser'].includes(mode) && canvas.hasPointerCapture(event.pointerId) && mode === 'eraser') { const radius = drawWidth * 2 / canvas.clientWidth; current().strokes = current().strokes.filter(stroke => !stroke.points.some((q, i) => i ? pointDistance(p, stroke.points[i - 1], q) < radius : Math.hypot(p.x - q.x, p.y - q.y) < radius)); renderCanvas(); }
  });
  layer.addEventListener('pointermove', event => {
    if (!dragAction) return; const rect = $('board').getBoundingClientRect(), dx = (event.clientX - (canvas.getBoundingClientRect().left + dragAction.start.x)) / rect.width, dy = (event.clientY - (canvas.getBoundingClientRect().top + dragAction.start.y)) / rect.height;
    if (dragAction.type === 'activity-move') {
      const a = current().activities.find(item => item.id === dragAction.id); if (!a) return;
      a.x = Math.max(0, Math.min(1 - a.w, dragAction.before.x + (event.clientX - dragAction.start.x) / rect.width)); a.y = Math.max(0, Math.min(1 - a.h, dragAction.before.y + (event.clientY - dragAction.start.y) / rect.height));
      const el = layer.querySelector(`[data-activity-id="${CSS.escape(a.id)}"]`); if (el) { el.style.left = `${a.x * 100}%`; el.style.top = `${a.y * 100}%`; }
    } else if (dragAction.type === 'activity-resize') { const a = current().activities.find(item => item.id === dragAction.id); if (!a) return; a.w = Math.max(.22, Math.min(1 - a.x, dragAction.before.w + (event.clientX - dragAction.start.x) / rect.width)); a.h = Math.max(.18, Math.min(1 - a.y, dragAction.before.h + (event.clientY - dragAction.start.y) / rect.height)); a.resized = true; const el = layer.querySelector(`[data-activity-id="${CSS.escape(a.id)}"]`); if (el) { el.style.width = `${a.w * 100}%`; el.style.height = `${a.h * 100}%`; } } else if (dragAction.type === 'activity-card') {
      const a = current().activities.find(item => item.id === dragAction.id), item = a?.items.find(row => row.id === dragAction.itemId); if (!item) return;
      const parent = layer.querySelector(`[data-activity-id="${CSS.escape(a.id)}"]`), w = parent.clientWidth, h = parent.clientHeight;
      item.x = Math.max(0, Math.min(.94, dragAction.before.x + (event.clientX - dragAction.start.x) / w)); item.y = Math.max(0, Math.min(.94, dragAction.before.y + (event.clientY - dragAction.start.y) / h));
      const card = parent.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`); if (card) { card.style.left = `${item.x * 100}%`; card.style.top = `${item.y * 100}%`; }
    } else if (dragAction.type === 'activity-marker') {
      const a = current().activities.find(item => item.id === dragAction.id), track = layer.querySelector(`.number-track[data-activity-id="${CSS.escape(dragAction.id)}"]`); if (!a || !track) return;
      const bounds = track.getBoundingClientRect(); a.marker = Math.max(0, Math.min(dragAction.total, Math.round((event.clientX - bounds.left) / bounds.width * dragAction.total)));
      const marker = track.querySelector('.number-marker'); marker.style.left = `${dragAction.total ? a.marker / dragAction.total * 100 : 0}%`; marker.textContent = String(a.min + a.marker * a.step); marker.setAttribute('aria-label', `Marker at ${marker.textContent}`);
    } else if (dragAction.type === 'box') {
      const box = current().boxes.find(item => item.id === dragAction.id); if (!box) return;
      if (dragAction.action === 'move') { box.x = Math.max(0, Math.min(1 - box.w, dragAction.before.x + dx)); box.y = Math.max(0, Math.min(1 - box.h, dragAction.before.y + dy)); }
      else { box.w = Math.max(.08, Math.min(1 - box.x, dragAction.before.w + dx)); box.h = Math.max(.06, Math.min(1 - box.y, dragAction.before.h + dy)); }
      renderBoxes();
    } else {
      const shape = current().shapes.find(item => item.id === dragAction.id); if (!shape) return;
      if (dragAction.action === 'move') { shape.x = Math.max(0, Math.min(1 - shape.w, dragAction.before.x + dx)); shape.y = Math.max(0, Math.min(1 - shape.h, dragAction.before.y + dy)); }
      else { shape.w = Math.max(.01, Math.min(1 - dragAction.before.x, dragAction.before.w + dx)); shape.h = Math.max(.01, Math.min(1 - dragAction.before.y, dragAction.before.h + dy)); }
      renderCanvas(); updateSelection();
    }
  });
  function endPointer(event) {
    if (dragAction) { dragAction = null; save(); lastSnapshot = capture(); }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (activeShape) { if (activeShape.w > .003 || activeShape.h > .003) current().shapes.push(normalizeShape(activeShape)); activeShape = null; renderCanvas(); save(); lastSnapshot = capture(); }
    if (activeStroke) { activeStroke = null; renderCanvas(); save(); lastSnapshot = capture(); }
  }
  canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer);
  layer.addEventListener('pointerup', () => { if (dragAction) {
    if (dragAction.type === 'activity-card') { const a = current().activities.find(item => item.id === dragAction.id); if (a?.type === 'sorting') { const item = a.items.find(row => row.id === dragAction.itemId); if (item) { const target = item.y < .68 ? Math.min(a.categories.length - 1, Math.floor(item.x * a.categories.length)) : -1; item.category = target; if (target >= 0) { const peers = a.items.filter(row => row.id !== item.id && row.category === target).length; item.x = (target + .08) / a.categories.length; item.y = Math.min(.58, .18 + peers * .11); } else item.y = Math.max(.78, item.y); renderActivities(); } } }
    dragAction = null; save(); lastSnapshot = capture();
  } });
  layer.addEventListener('pointercancel', () => { if (dragAction) { dragAction = null; save(); lastSnapshot = capture(); } });
  function applyHistory(entry) { const board = boards.find(item => item.id === entry.boardId); if (!board) return; saveCurrent(); setSnapshot(board, entry.state); applyBoard(board.id); }
  $('undo').addEventListener('click', () => { clearTimeout(typingTimer); typingTimer = 0; if (typingBefore) { historyPush(typingBefore); typingBefore = null; } const index = undoStack.map(item => item.boardId).lastIndexOf(currentId); if (index < 0) return; const [entry] = undoStack.splice(index, 1); redoStack.push({ boardId: currentId, state: capture() }); applyHistory(entry); });
  $('redo').addEventListener('click', () => { const index = redoStack.map(item => item.boardId).lastIndexOf(currentId); if (index < 0) return; const [entry] = redoStack.splice(index, 1); undoStack.push({ boardId: currentId, state: capture() }); applyHistory(entry); });
  document.addEventListener('keydown', event => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && !event.target.isContentEditable && mode === 'select') {
      if (selectedBox) { historyPush(); current().boxes = current().boxes.filter(box => box.id !== selectedBox); selectedBox = ''; renderBoxes(); save(); lastSnapshot = capture(); }
      else if (selectedShape) { historyPush(); current().shapes = current().shapes.filter(shape => shape.id !== selectedShape); selectedShape = ''; renderCanvas(); updateSelection(); save(); lastSnapshot = capture(); }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.target.isContentEditable) { event.preventDefault(); $(event.shiftKey ? 'redo' : 'undo').click(); }
  });
  $('background').addEventListener('change', event => { current().background = event.target.value; $('board').className = `background-${current().background}`; save(); lastSnapshot = capture(); });
  $('clear').addEventListener('click', () => $('clear-dialog').showModal());
  $('clear-dialog').querySelector('form').addEventListener('submit', event => { event.preventDefault(); $('clear-dialog').close(); if (event.submitter.value !== 'clear') return; previous = capture(); const board = current(); setSnapshot(board, { ...freshBoard(), id: board.id, date: today() }); applyBoard(board.id); undoStack = undoStack.filter(item => item.boardId !== board.id); redoStack = redoStack.filter(item => item.boardId !== board.id); save(); });
  $('restore').addEventListener('click', () => $('restore-dialog').showModal()); $('restore-dialog').querySelector('form').addEventListener('submit', event => { event.preventDefault(); $('restore-dialog').close(); if (event.submitter.value !== 'restore' || !previous) return; const old = capture(); setSnapshot(current(), previous); previous = old; applyBoard(currentId); save(); });
  $('delete-dialog').querySelector('form').addEventListener('submit', event => { event.preventDefault(); $('delete-dialog').close(); if (event.submitter.value !== 'delete' || boards.length < 2) return; const index = boards.findIndex(item => item.id === deleteTarget); boards = boards.filter(item => item.id !== deleteTarget); if (currentId === deleteTarget) currentId = boards[Math.max(0, index - 1)].id; deleteTarget = ''; undoStack = []; redoStack = []; applyBoard(currentId); });
  $('fresh').addEventListener('click', () => $('fresh-dialog').showModal()); $('fresh-dialog').querySelector('form').addEventListener('submit', event => { event.preventDefault(); $('fresh-dialog').close(); if (event.submitter.value !== 'fresh') return; boards = [makeBlankBoard()]; currentId = boards[0].id; previous = null; timer = { remaining: 300000, endsAt: 0, running: false }; timerHidden = true; undoStack = []; redoStack = []; clearTimeout(typingTimer); loadActive(); renderTimer(); save(); });
  function configuredTime() { const preset = $('timer-preset').value, minutes = preset === 'custom' ? Number($('custom-minutes').value) : Number(preset); return Math.max(1, Math.min(180, Number.isFinite(minutes) ? minutes : 3)) * 60000; }
  $('timer-preset').addEventListener('change', () => { $('custom-label').hidden = $('timer-preset').value !== 'custom'; if (!timer.running) { timer.remaining = configuredTime(); renderTimer(); save(); } });
  function formatTime(ms) { const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
  function beep() { if (!$('timer-sound').checked) return; try { const audio = new AudioContext(), oscillator = audio.createOscillator(), gain = audio.createGain(); oscillator.frequency.value = 880; gain.gain.value = .12; oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + .65); oscillator.onended = () => audio.close(); } catch (_) {} }
  function renderTimer() { if (timer.running) timer.remaining = Math.max(0, timer.endsAt - Date.now()); if (timer.running && timer.remaining === 0) { timer.running = false; if (!timerEnded) { timerEnded = true; beep(); } } $('timer-value').textContent = formatTime(timer.remaining); $('timer-display').hidden = timerHidden; $('timer-show').hidden = !timerHidden; $('timer-toggle').textContent = timer.running ? 'Pause timer' : 'Start timer'; if (!timer.running && timer.remaining === 0) status('Timer finished'); }
  $('timer-toggle').addEventListener('click', () => { if (timer.running) { timer.remaining = Math.max(0, timer.endsAt - Date.now()); timer.running = false; } else { if (timer.remaining <= 0) timer.remaining = configuredTime(); timer.endsAt = Date.now() + timer.remaining; timer.running = true; timerEnded = false; timerHidden = false; } renderTimer(); save(); });
  $('timer-reset').addEventListener('click', () => { timer = { remaining: configuredTime(), endsAt: 0, running: false }; timerEnded = false; timerHidden = false; renderTimer(); save(); });
  function updateCustomTimer() { if (!timer.running) { timer.remaining = configuredTime(); renderTimer(); save(); } } $('custom-minutes').addEventListener('input', updateCustomTimer); $('custom-minutes').addEventListener('change', updateCustomTimer);
  $('timer-hide').addEventListener('click', () => { timerHidden = true; renderTimer(); save(); }); $('timer-show').addEventListener('click', () => { timerHidden = false; renderTimer(); save(); }); $('timer-sound').addEventListener('change', save);
  function fullscreenLabel() { const on = Boolean(document.fullscreenElement || document.webkitFullscreenElement || fullScreenFallback); $('fullscreen').textContent = on ? 'Exit fullscreen' : 'Fullscreen'; $('fullscreen').setAttribute('aria-pressed', String(on)); }
  $('fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else if (document.webkitFullscreenElement) document.webkitExitFullscreen(); else if (document.documentElement.webkitRequestFullscreen) document.documentElement.webkitRequestFullscreen(); else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); else { fullScreenFallback = !fullScreenFallback; document.body.classList.toggle('presentation', fullScreenFallback); } fullscreenLabel(); } catch (_) { status('Use your browser’s fullscreen option', true); } });
  document.addEventListener('fullscreenchange', fullscreenLabel); document.addEventListener('webkitfullscreenchange', fullscreenLabel);
  document.addEventListener('click', event => { const details = document.querySelector('.more'); if (details.open && !details.contains(event.target)) details.open = false; });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); }); window.addEventListener('pagehide', save);
  setInterval(() => { renderTimer(); if (!current().dateManual && $('date').textContent !== today()) { $('date').textContent = today(); save(); } }, 1000);
  setMode('text'); renderTimer(); save();
})();
