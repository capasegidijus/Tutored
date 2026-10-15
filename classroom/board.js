'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const fields = ['date', 'subject', 'writing'].map($);
  const KEY = 'classroom-board.v1';
  const today = () => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const freshBoard = () => ({ id: uid(), date: '', subject: '', writing: '', dateManual: false, sizes: ['', '', ''], strokes: [], shapes: [], boxes: [], background: 'plain' });
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
  function capture(board = current()) {
    if (!board) return null;
    if (board.id === currentId) saveCurrent();
    return { date: board.date, subject: board.subject, writing: board.writing, dateManual: board.dateManual, sizes: board.sizes.slice(), strokes: structuredClone(board.strokes), shapes: structuredClone(board.shapes), boxes: structuredClone(board.boxes), background: board.background };
  }
  function setSnapshot(board, data) {
    board.date = clean(data.date); board.subject = clean(data.subject); board.writing = clean(data.writing);
    board.dateManual = Boolean(data.dateManual);
    board.sizes = Array.isArray(data.sizes) ? data.sizes.map(size => /^\d+(\.\d+)?px$/.test(size || '') ? size : '') : ['', '', ''];
    board.strokes = Array.isArray(data.strokes) ? data.strokes.map(normalizedStroke).filter(Boolean) : [];
    board.shapes = Array.isArray(data.shapes) ? data.shapes.map(normalizeShape).filter(Boolean) : [];
    board.boxes = Array.isArray(data.boxes) ? data.boxes.map(normalizeBox).filter(Boolean) : [];
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
    try { localStorage.setItem(KEY, JSON.stringify({ version: 3, boards, currentId, previous, timer, timerHidden, timerSound: $('timer-sound').checked })); status('Saved in this browser'); }
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
    if (data.length !== currentNodes.size || data.some(item => !currentNodes.has(item.id))) { layer.replaceChildren(); data.forEach(box => boxNode(box)); }
    for (const box of data) {
      const el = layer.querySelector(`[data-id="${CSS.escape(box.id)}"]`); if (!el) continue;
      el.style.left = `${box.x * 100}%`; el.style.top = `${box.y * 100}%`; el.style.width = `${box.w * 100}%`; el.style.height = `${box.h * 100}%`;
      el.classList.toggle('selected', box.id === selectedBox); el.querySelector('.box-content').contentEditable = String(mode === 'text');
    }
    updateSelection();
  }
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
    selection = null; active = $('writing'); selectedBox = ''; selectedShape = ''; renderBoxes(); renderCanvas(); renderTabs(); lastSnapshot = capture(); save();
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
    renderTabs(); renderBoxes(); renderCanvas(); lastSnapshot = capture();
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
    if (dragAction.type === 'box') {
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
  layer.addEventListener('pointerup', () => { if (dragAction) { dragAction = null; save(); lastSnapshot = capture(); } });
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
