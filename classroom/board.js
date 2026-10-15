'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const fields = ['date', 'subject', 'writing'].map($);
  const KEY = 'classroom-board.v1';
  const today = () => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const freshBoard = () => ({ id: crypto.randomUUID(), date: '', subject: '', writing: '', dateManual: false, sizes: ['', '', ''], strokes: [], background: 'plain' });
  let boards = [], currentId = '', previous = null, active = $('writing'), selection = null;
  let mode = 'text', penColor = '#202124', penWidth = 6, activeStroke = null, strokeBefore = null, deleteTarget = '';
  let undoStack = [], redoStack = [], typingTimer = 0, typingBefore = null, lastSnapshot = null;
  let timer = { remaining: 300000, endsAt: 0, running: false }, timerHidden = true, timerEnded = false;
  let fullScreenFallback = false;
  const canvas = $('ink'), ctx = canvas.getContext('2d');
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
        const style = node.style, safe = {};
        for (const name of ['color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line']) {
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
  function docSnapshot(board = current()) {
    if (board.id === currentId) return { date: $('date').innerHTML, subject: $('subject').innerHTML, writing: $('writing').innerHTML, dateManual: current().dateManual, sizes: fields.map(el => el.style.fontSize), strokes: structuredClone(current().strokes), background: current().background };
    return { date: board.date, subject: board.subject, writing: board.writing, dateManual: board.dateManual, sizes: board.sizes.slice(), strokes: structuredClone(board.strokes), background: board.background };
  }
  function setDocSnapshot(board, data) {
    board.date = clean(data.date); board.subject = clean(data.subject); board.writing = clean(data.writing);
    board.dateManual = Boolean(data.dateManual); board.sizes = Array.isArray(data.sizes) ? data.sizes.map(size => /^\d+(\.\d+)?px$/.test(size || '') ? size : '') : ['', '', ''];
    board.strokes = Array.isArray(data.strokes) ? data.strokes.filter(stroke => stroke && Array.isArray(stroke.points) && stroke.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).map(stroke => ({ color: /^#[\da-f]{6}$/i.test(stroke.color) ? stroke.color : '#202124', width: Number.isFinite(stroke.width) ? Math.max(.001, Math.min(.04, stroke.width)) : .005, points: stroke.points.map(p => ({x: Math.max(0, Math.min(1,p.x)), y: Math.max(0, Math.min(1,p.y))})) })) : [];
    board.background = ['plain','lines','grid','dots'].includes(data.background) ? data.background : 'plain';
  }
  function saveCurrent() {
    const board = current(); if (!board) return;
    board.date = $('date').innerHTML; board.subject = $('subject').innerHTML; board.writing = $('writing').innerHTML;
    board.sizes = fields.map(el => el.style.fontSize);
  }
  function save() {
    saveCurrent();
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 2, boards, currentId, previous, timer, timerHidden, timerSound: $('timer-sound').checked }));
      status('Saved in this browser');
    } catch (_) { status('Saving unavailable — keep this tab open', true); }
    $('restore').disabled = !previous;
    $('undo').disabled = !undoStack.some(entry => entry.boardId === currentId);
    $('redo').disabled = !redoStack.some(entry => entry.boardId === currentId);
  }
  function renderCanvas() {
    const rect = $('board').getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio)); canvas.height = Math.max(1, Math.round(rect.height * ratio));
    canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
    ctx.setTransform(ratio,0,0,ratio,0,0); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const board = current(), w = rect.width, h = rect.height;
    for (const stroke of board?.strokes || []) {
      ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width * w;
      ctx.beginPath(); stroke.points.forEach((point,i) => { const x=point.x*w,y=point.y*h; if(!i)ctx.moveTo(x,y);else ctx.lineTo(x,y); });
      const first=stroke.points[0]; if(stroke.points.length===1){ctx.moveTo(first.x*w,first.y*h);ctx.lineTo(first.x*w+.1,first.y*h+.1);} ctx.stroke();
    }
  }
  const resizeObserver = new ResizeObserver(renderCanvas); resizeObserver.observe($('board'));
  window.addEventListener('resize',renderCanvas);
  function applyBoard(id) {
    clearTimeout(typingTimer); typingTimer=0; typingBefore=null;
    saveCurrent(); currentId=id; const board=current(); if(!board)return;
    fields.forEach((field,i)=>{ field.innerHTML=clean(board[field.id]); field.style.fontSize=board.sizes[i]||''; });
    if(!board.dateManual)$('date').textContent=today();
    $('board').className=`background-${board.background}`; $('background').value=board.background;
    selection=null; active=$('writing'); renderCanvas(); renderTabs(); lastSnapshot=docSnapshot(); save();
  }
  function makeBlankBoard() { const board=freshBoard(); board.date=today(); return board; }
  function renderTabs() {
    const nav=$('board-tabs'); nav.replaceChildren();
    boards.forEach((board,index)=>{
      const tab=document.createElement('button'); tab.className='board-tab'; tab.type='button'; tab.setAttribute('aria-label',`Board ${index+1}`); tab.setAttribute('aria-current',String(board.id===currentId)); tab.append(document.createTextNode(String(index+1)));
      if(boards.length>1){const remove=document.createElement('span');remove.className='remove-tab';remove.textContent='×';remove.setAttribute('role','button');remove.setAttribute('aria-label',`Delete board ${index+1}`);remove.addEventListener('click',event=>{event.stopPropagation();deleteTarget=board.id;$('delete-dialog').showModal();});tab.append(remove);}
      tab.addEventListener('click',()=>{if(board.id!==currentId){saveCurrent();applyBoard(board.id);}});nav.append(tab);
    });
    const add=document.createElement('button');add.type='button';add.className='add-board';add.textContent='+';add.setAttribute('aria-label','Add a board');add.title='Add a board';add.addEventListener('click',()=>{saveCurrent();const board=makeBlankBoard();boards.push(board);applyBoard(board.id);});nav.append(add);
  }
  try {
    const saved=JSON.parse(localStorage.getItem(KEY)||'null');
    if(saved?.version===2&&Array.isArray(saved.boards)&&saved.boards.length){
      boards=saved.boards.map(source=>{const board={...freshBoard(),id:typeof source.id==='string'?source.id:crypto.randomUUID()};setDocSnapshot(board,source);return board;});
      currentId=boards.some(b=>b.id===saved.currentId)?saved.currentId:boards[0].id; previous=saved.previous||null;
      if(saved.timer&&Number.isFinite(saved.timer.remaining)){timer={remaining:Math.max(0,saved.timer.remaining),endsAt:Number(saved.timer.endsAt)||0,running:Boolean(saved.timer.running)};}
      timerHidden=saved.timerHidden!==false; $('timer-sound').checked=Boolean(saved.timerSound);
    } else if(saved?.current){const board=makeBlankBoard();setDocSnapshot(board,saved.current);boards=[board];currentId=board.id;previous=saved.previous||null;}
    else {const board=makeBlankBoard();boards=[board];currentId=board.id;}
  } catch (_) {const board=makeBlankBoard();boards=[board];currentId=board.id;status('Saved board unavailable',true);}
  function loadActive() {
    const board=current(); fields.forEach((field,i)=>{field.innerHTML=clean(board[field.id]);field.style.fontSize=board.sizes[i]||'';});
    if(!board.dateManual)$('date').textContent=today();
    $('board').className=`background-${board.background}`;$('background').value=board.background;
    renderTabs();renderCanvas();lastSnapshot=docSnapshot();
  }
  loadActive();
  function remember() {
    const sel=window.getSelection();if(!sel.rangeCount)return;const range=sel.getRangeAt(0);
    const field=fields.find(el=>el.contains(range.startContainer)&&el.contains(range.endContainer));
    if(field){active=field;selection=range.cloneRange();$('bold').setAttribute('aria-pressed',String(document.queryCommandState('bold')));$('underline').setAttribute('aria-pressed',String(document.queryCommandState('underline')));
      const anchor=range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer:range.startContainer.parentElement,style=getComputedStyle(anchor),size=String(Math.round(parseFloat(style.fontSize)));
      if([...$('size').options].some(option=>option.value===size))$('size').value=size;const rgb=style.color.match(/\d+/g);if(rgb?.length>=3)$('colour').value='#'+rgb.slice(0,3).map(n=>Number(n).toString(16).padStart(2,'0')).join('');}
  }
  document.addEventListener('selectionchange',remember);
  function restoreSelection(){active.focus();const sel=window.getSelection();sel.removeAllRanges();if(selection&&active.contains(selection.startContainer)&&active.contains(selection.endContainer))sel.addRange(selection);else{const range=document.createRange();range.selectNodeContents(active);range.collapse(false);sel.addRange(range);}}
  function format(command,value){if(mode!=='text')setMode('text');restoreSelection();document.execCommand('styleWithCSS',false,true);document.execCommand(command,false,value);if(active.id==='date')current().dateManual=true;remember();save();lastSnapshot=docSnapshot();}
  for(const name of ['bold','underline']){$(name).addEventListener('mousedown',event=>event.preventDefault());$(name).addEventListener('click',()=>format(name));}
  document.querySelector('.tools').addEventListener('pointerdown',remember);
  $('colour').addEventListener('input',event=>format('foreColor',event.target.value));$('colour').addEventListener('change',event=>format('foreColor',event.target.value));
  $('size').addEventListener('change',event=>{restoreSelection();const size=event.target.value,range=window.getSelection().getRangeAt(0);if(range.collapsed){active.style.fontSize=`${size}px`;active.querySelectorAll('[style]').forEach(el=>el.style.removeProperty('font-size'));}else{document.execCommand('styleWithCSS',false,false);document.execCommand('fontSize',false,'7');active.querySelectorAll('font[size="7"]').forEach(el=>{el.removeAttribute('size');el.style.fontSize=`${size}px`;});}remember();save();lastSnapshot=docSnapshot();});
  function queueTyping(){if(!typingTimer)typingBefore=lastSnapshot||docSnapshot();const boardId=currentId;clearTimeout(typingTimer);typingTimer=setTimeout(()=>{if(typingBefore){undoStack.push({boardId,state:typingBefore});if(undoStack.length>80)undoStack.shift();redoStack=[];}typingTimer=0;typingBefore=null;lastSnapshot=docSnapshot();save();},450);}
  fields.forEach(field=>{field.addEventListener('focus',()=>{if(mode==='text')active=field;});field.addEventListener('input',()=>{if(field.id==='date')current().dateManual=true;if(!field.textContent.trim()&&!field.querySelector('img'))field.innerHTML='';queueTyping();save();});field.addEventListener('paste',event=>{event.preventDefault();document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));});if(field.id!=='writing')field.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();fields[fields.indexOf(field)+1].focus();}});});
  function setMode(next){mode=next;fields.forEach(field=>field.contentEditable=String(mode==='text'));document.body.classList.toggle('mode-pen',mode==='pen');document.body.classList.toggle('mode-eraser',mode==='eraser');$('text-mode').classList.toggle('active',mode==='text');$('pen-mode').classList.toggle('active',mode==='pen');$('eraser-mode').classList.toggle('active',mode==='eraser');$('text-mode').setAttribute('aria-pressed',String(mode==='text'));$('pen-mode').setAttribute('aria-pressed',String(mode==='pen'));$('eraser-mode').setAttribute('aria-pressed',String(mode==='eraser'));$('text-tools').hidden=mode!=='text';$('pen-tools').hidden=mode==='text';if(mode==='text')active.focus();}
  $('text-mode').addEventListener('click',()=>setMode('text'));$('pen-mode').addEventListener('click',()=>setMode('pen'));$('eraser-mode').addEventListener('click',()=>setMode('eraser'));
  $('pen-colour').addEventListener('change',event=>{penColor=event.target.value;});$('pen-width').addEventListener('change',event=>{penWidth=Number(event.target.value);});
  function pointerPoint(event){const rect=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};}
  function pointDistance(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,len=dx*dx+dy*dy,t=len?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len)):0;return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy));}
  canvas.addEventListener('pointerdown',event=>{if(mode==='text')return;event.preventDefault();canvas.setPointerCapture(event.pointerId);const point=pointerPoint(event);strokeBefore=docSnapshot();undoStack.push({boardId:currentId,state:strokeBefore});if(undoStack.length>80)undoStack.shift();redoStack=[];save();if(mode==='pen')activeStroke={color:penColor,width:penWidth/canvas.clientWidth,points:[point]},current().strokes.push(activeStroke);else{const radius=(penWidth*2)/canvas.clientWidth;current().strokes=current().strokes.filter(stroke=>!stroke.points.some((p,i)=>i?pointDistance(point,stroke.points[i-1],p)<radius:Math.hypot(point.x-p.x,point.y-p.y)<radius));}renderCanvas();});
  canvas.addEventListener('pointermove',event=>{if(!canvas.hasPointerCapture(event.pointerId))return;event.preventDefault();const point=pointerPoint(event);if(mode==='pen'&&activeStroke){activeStroke.points.push(point);renderCanvas();}else if(mode==='eraser'){const radius=(penWidth*2)/canvas.clientWidth;const strokes=current().strokes;current().strokes=strokes.filter(stroke=>!stroke.points.some((p,i)=>i?pointDistance(point,stroke.points[i-1],p)<radius:Math.hypot(point.x-p.x,point.y-p.y)<radius));renderCanvas();}});
  function endPointer(event){if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);activeStroke=null;strokeBefore=null;save();lastSnapshot=docSnapshot();}
  canvas.addEventListener('pointerup',endPointer);canvas.addEventListener('pointercancel',endPointer);
  function applyHistory(entry){const board=boards.find(item=>item.id===entry.boardId);if(!board)return;saveCurrent();setDocSnapshot(board,entry.state);applyBoard(board.id);}
  $('undo').addEventListener('click',()=>{clearTimeout(typingTimer);typingTimer=0;if(typingBefore){undoStack.push({boardId:currentId,state:typingBefore});typingBefore=null;}const index=undoStack.map(entry=>entry.boardId).lastIndexOf(currentId);if(index<0)return;const [entry]=undoStack.splice(index,1);redoStack.push({boardId:currentId,state:docSnapshot()});applyHistory(entry);});
  $('redo').addEventListener('click',()=>{const index=redoStack.map(entry=>entry.boardId).lastIndexOf(currentId);if(index<0)return;const [entry]=redoStack.splice(index,1);undoStack.push({boardId:currentId,state:docSnapshot()});applyHistory(entry);});
  $('background').addEventListener('change',event=>{current().background=event.target.value;$('board').className=`background-${current().background}`;save();lastSnapshot=docSnapshot();});
  $('clear').addEventListener('click',()=>$('clear-dialog').showModal());
  $('clear-dialog').querySelector('form').addEventListener('submit',event=>{event.preventDefault();$('clear-dialog').close();if(event.submitter.value!=='clear')return;previous=docSnapshot();const board=current();setDocSnapshot(board,{...freshBoard(),id:board.id,date:today()});applyBoard(board.id);undoStack=undoStack.filter(entry=>entry.boardId!==board.id);redoStack=redoStack.filter(entry=>entry.boardId!==board.id);save();});
  $('restore').addEventListener('click',()=>$('restore-dialog').showModal());$('restore-dialog').querySelector('form').addEventListener('submit',event=>{event.preventDefault();$('restore-dialog').close();if(event.submitter.value!=='restore'||!previous)return;const old=docSnapshot();setDocSnapshot(current(),previous);previous=old;applyBoard(currentId);save();});
  $('delete-dialog').querySelector('form').addEventListener('submit',event=>{event.preventDefault();$('delete-dialog').close();if(event.submitter.value!=='delete'||boards.length<2)return;const index=boards.findIndex(board=>board.id===deleteTarget);boards=boards.filter(board=>board.id!==deleteTarget);if(currentId===deleteTarget)currentId=boards[Math.max(0,index-1)].id;deleteTarget='';undoStack=[];redoStack=[];applyBoard(currentId);});
  $('fresh').addEventListener('click',()=>$('fresh-dialog').showModal());$('fresh-dialog').querySelector('form').addEventListener('submit',event=>{event.preventDefault();$('fresh-dialog').close();if(event.submitter.value!=='fresh')return;boards=[makeBlankBoard()];currentId=boards[0].id;previous=null;timer={remaining:300000,endsAt:0,running:false};timerHidden=true;undoStack=[];redoStack=[];clearTimeout(typingTimer);loadActive();renderTimer();save();});
  function configuredTime(){const preset=$('timer-preset').value;const minutes=preset==='custom'?Number($('custom-minutes').value):Number(preset);return Math.max(1,Math.min(180,Number.isFinite(minutes)?minutes:3))*60000;}
  $('timer-preset').addEventListener('change',()=>{$('custom-label').hidden=$('timer-preset').value!=='custom';if(!timer.running){timer.remaining=configuredTime();renderTimer();save();}});
  function formatTime(ms){const seconds=Math.max(0,Math.ceil(ms/1000));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
  function beep(){if(!$('timer-sound').checked)return;try{const audio=new AudioContext(),osc=audio.createOscillator(),gain=audio.createGain();osc.frequency.value=880;gain.gain.value=.12;osc.connect(gain);gain.connect(audio.destination);osc.start();osc.stop(audio.currentTime+.65);osc.onended=()=>audio.close();}catch(_){}}
  function renderTimer(){if(timer.running)timer.remaining=Math.max(0,timer.endsAt-Date.now());if(timer.running&&timer.remaining===0){timer.running=false;if(!timerEnded){timerEnded=true;beep();}}$('timer-value').textContent=formatTime(timer.remaining);$('timer-display').hidden=timerHidden;$('timer-show').hidden=!timerHidden;$('timer-toggle').textContent=timer.running?'Pause timer':'Start timer';if(!timer.running&&timer.remaining===0)status('Timer finished');}
  $('timer-toggle').addEventListener('click',()=>{if(timer.running){timer.remaining=Math.max(0,timer.endsAt-Date.now());timer.running=false;}else{if(timer.remaining<=0)timer.remaining=configuredTime();timer.endsAt=Date.now()+timer.remaining;timer.running=true;timerEnded=false;timerHidden=false;}renderTimer();save();});
  $('timer-reset').addEventListener('click',()=>{timer={remaining:configuredTime(),endsAt:0,running:false};timerEnded=false;timerHidden=false;renderTimer();save();});function updateCustomTimer(){if(!timer.running){timer.remaining=configuredTime();renderTimer();save();}}$('custom-minutes').addEventListener('input',updateCustomTimer);$('custom-minutes').addEventListener('change',updateCustomTimer);
  $('timer-hide').addEventListener('click',()=>{timerHidden=true;renderTimer();save();});$('timer-show').addEventListener('click',()=>{timerHidden=false;renderTimer();save();});$('timer-sound').addEventListener('change',save);
  function fullscreenLabel(){const on=Boolean(document.fullscreenElement||document.webkitFullscreenElement||fullScreenFallback);$('fullscreen').textContent=on?'Exit fullscreen':'Fullscreen';$('fullscreen').setAttribute('aria-pressed',String(on));}
  $('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.webkitFullscreenElement)document.webkitExitFullscreen();else if(document.documentElement.webkitRequestFullscreen)document.documentElement.webkitRequestFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else{fullScreenFallback=!fullScreenFallback;document.body.classList.toggle('presentation',fullScreenFallback);}fullscreenLabel();}catch(_){status('Use your browser’s fullscreen option',true);}});
  document.addEventListener('fullscreenchange',fullscreenLabel);document.addEventListener('webkitfullscreenchange',fullscreenLabel);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&fullScreenFallback){fullScreenFallback=false;document.body.classList.remove('presentation');fullscreenLabel();}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'&&!event.target.isContentEditable){event.preventDefault();$(event.shiftKey?'redo':'undo').click();}});
  document.addEventListener('click',event=>{const details=document.querySelector('.more');if(details.open&&!details.contains(event.target))details.open=false;});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')save();});window.addEventListener('pagehide',save);
  setInterval(()=>{renderTimer();if(!current().dateManual&&$('date').textContent!==today()){$('date').textContent=today();save();}},1000);
  renderTimer();save();
})();
