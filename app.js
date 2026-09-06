'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const localDate = () => {const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const steps = [
  {name:'回顾经历',question:'今天哪件事值得回顾？',hint:'先写一个具体片段：当时在做什么？你做了什么？后来发生了什么？不用一次写得很完整。',fields:[['experience','发生了什么？','textarea']]},
  {name:'发现优点',question:'这件事中，你做对了什么？',hint:'从你的一个具体行为开始。即使结果不完美，也可以看见过程中做得好的部分。',fields:[['strength','我做得好的地方','textarea'],['evidence','哪一个具体细节可以证明？','textarea']]},
  {name:'理解困难',question:'哪里不顺？什么是你能改变的？',hint:'把困难落到一件事、一个行为上。试着区分外部条件和自己下次可以调整的部分。',fields:[['difficulty','当时遇到了什么困难？','textarea'],['change','其中我能调整的一个行为','textarea']]},
  {name:'确定行动',question:'下次准备尝试什么小改变？',hint:'让行动足够小，能看得出是否做过。写下具体时机，给下次的自己一个提醒。',fields:[['action','我的一个小行动','textarea'],['when','什么时候、在什么情况下尝试？','text']]}
];
const fieldKeys = steps.flatMap(step => step.fields.map(field => field[0]));
let records = [], current = null, stepIndex = 0, revision = 0, dirty = false, timer = null, saveQueue = Promise.resolve(), urls = [], filterDate = '', dbError = '', saveMessage = '', saveError = false, closing = false;
const savedVersions = new Map();
const dialog = $('#first-step');
dialog.classList.add('editor');
const dbReady = new Promise((resolve, reject) => {
  if (!window.indexedDB) return reject(new Error('此浏览器无法使用本地数据库。'));
  const request = indexedDB.open('growth-journal', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('records', {keyPath:'id'});
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error('请关闭其他打开此网页的标签页后重试。'));
});
// Observe failures immediately, while preserving a rejecting promise for save attempts.
dbReady.catch(error => {dbError = error.message;});
async function getRecords() {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records', 'readonly');
    const request = transaction.objectStore('records').getAll();
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || new Error('读取被中断'));
    transaction.onerror = () => reject(transaction.error);
  });
}
async function writeRecord(record) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records', 'readwrite');
    const store = transaction.objectStore('records');
    const previous = store.get(record.id);
    let conflict = false;
    previous.onsuccess = () => {
      if (previous.result && previous.result.updatedAt !== savedVersions.get(record.id)) {conflict = true; transaction.abort();}
      else store.put(record);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(conflict ? Object.assign(new Error('另一页面已修改这条记录'),{name:'ConflictError'}) : transaction.error || new Error('保存被中断'));
    transaction.onerror = () => reject(transaction.error);
  });
}
function toast(message) { $('#notice').textContent = message; clearTimeout(toast.timer); toast.timer = setTimeout(() => {$('#notice').textContent = '';}, 5500); }
function setSaveState(message, error = false) {
  saveMessage = message; saveError = error;
  const status = $('#save-state');
  if (status) {status.textContent = message; status.classList.toggle('error', error);}
}
function validURL(text) {try {const url = new URL(text); return ['http:','https:'].includes(url.protocol) ? url.href : null;} catch {return null;}}
function invalidMaterial(record) {return record.materials.find(material => material.type === 'link' && material.text.trim() && !validURL(material.text.trim()));}
function markChanged() {
  revision++; dirty = true;
  setSaveState('尚未保存 · 停止输入后会自动保存');
  clearTimeout(timer); timer = setTimeout(() => persist(), 800);
}
function persist() {
  clearTimeout(timer);
  if (!current) return Promise.resolve(true);
  if (invalidMaterial(current)) {
    setSaveState('尚未保存：材料链接需要完整的 http:// 或 https:// 地址。输入内容仍在，请返回对应步骤修改。', true);
    return Promise.resolve(false);
  }
  const snapshot = structuredClone(current), savedRevision = revision;
  snapshot.updatedAt = new Date().toISOString();
  setSaveState('正在保存，请稍候…');
  const task = saveQueue.then(async () => {
    try {
      await writeRecord(snapshot);
      savedVersions.set(snapshot.id, snapshot.updatedAt);
      records = records.filter(record => record.id !== snapshot.id).concat(snapshot);
      if (current?.id === snapshot.id && revision === savedRevision) {dirty = false; setSaveState('已保存到当前浏览器');}
      renderHome();
      return true;
    } catch (error) {
      if (error?.name === 'ConflictError') {
        setSaveState('未覆盖另一页面的新内容。当前输入仍在，请点击“另存为新复盘”保留这份修改，或保留当前页面继续查看。', true);
        const copyButton = $('[data-do="save-copy"]', dialog); if (copyButton) copyButton.hidden = false;
        return false;
      }
      const reason = error?.name === 'QuotaExceededError' ? '浏览器存储空间不足' : '本地存储不可用或写入被中断';
      setSaveState(`保存失败：${reason}。当前输入和已选择的附件仍保留在页面中，请勿关闭页面，可点击“重试保存”。`, true);
      return false;
    }
  });
  saveQueue = task.then(() => undefined);
  return task;
}
function titleOf(record) {return record.title.trim() || record.experience.trim().slice(0,32) || '未命名复盘';}
function filledSteps(record) {return steps.filter(step => step.fields.some(([key]) => record[key].trim())).length;}
function sortedRecords() {return [...records].sort((a,b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));}
function renderHome() {
  const all = sortedRecords();
  const today = localDate();
  $('#today-date').textContent = new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date());
  const draft = all.find(record => record.date === today && record.status === 'draft');
  const done = all.find(record => record.date === today && record.status === 'complete');
  $('#start').textContent = draft ? '继续今日复盘 ↗' : done ? '再记一件小事 ↗' : '开始今日复盘 ↗';
  $('.today .status').textContent = draft ? `已填写 ${filledSteps(draft)}/4 步` : done ? '今日已记录' : '未开始';
  const pending = all.find(record => record.status === 'complete' && record.action.trim() && (record.followStatus !== '已尝试' || !record.effect.trim()));
  const actionBox = $('#action-title').closest('section');
  actionBox.querySelector('.card').outerHTML = pending ? `<div class="card action"><p class="eyebrow">${escapeHTML(pending.date)} · ${escapeHTML(pending.followStatus)}</p><p class="snippet">${escapeHTML(pending.action)}</p><p>${escapeHTML(pending.when || '尝试时机暂未填写')}</p><button class="secondary" data-follow="${pending.id}" type="button">记录尝试与效果</button></div>` : '<div class="card action"><p class="eyebrow">给改变留一点空间</p><p>目前没有待回访的小行动。</p><p>完成复盘后，你的小行动会出现在这里。</p></div>';
  const strengthBox = $('#strength-title').closest('section');
  let strengthRows = $('.strength-rows', strengthBox);
  if (!strengthRows) {strengthBox.querySelector('.card').remove(); strengthRows = document.createElement('div'); strengthRows.className = 'rows strength-rows'; strengthBox.append(strengthRows);}
  const strengths = all.filter(record => record.status === 'complete' && record.strength.trim() && record.evidence.trim());
  strengthRows.innerHTML = strengths.length ? strengths.map(record => `<button class="card evidence record" data-open="${record.id}" type="button"><span class="eyebrow">${escapeHTML(record.date)}</span><p class="record-title snippet">${escapeHTML(record.strength)}</p><p class="subtle snippet">具体事例：${escapeHTML(record.evidence)}</p><span class="subtle">查看原复盘 →</span></button>`).join('') : '<div class="card evidence"><p>记录一个你做得好的细节，<br>它会出现在这里。</p><p class="subtle">每一个优点，都有一件小事作为依据。</p></div>';
  const historyBox = $('#history-title').closest('section');
  let historyRows = $('.history-rows', historyBox);
  if (!historyRows) {
    historyBox.querySelector('.footprints').remove();
    const filter = document.createElement('div'); filter.className = 'date-filter';
    filter.innerHTML = '<label for="history-date">按日期查看</label><input id="history-date" type="date"><button class="text-button" id="clear-filter" type="button">全部日期</button>';
    historyBox.append(filter);
    historyRows = document.createElement('div'); historyRows.className = 'rows history-rows'; historyBox.append(historyRows);
    $('#history-date').addEventListener('change', event => {filterDate = event.target.value; renderHome();});
    $('#clear-filter').addEventListener('click', () => {filterDate = ''; $('#history-date').value = ''; renderHome();});
  }
  const visible = all.filter(record => !filterDate || record.date === filterDate);
  historyRows.innerHTML = visible.length ? visible.map(record => `<button class="card record history-card" data-open="${record.id}" type="button"><span class="eyebrow">${escapeHTML(record.date)}</span><span class="badge">${record.status === 'draft' ? '草稿' : '已完成'}</span><p class="record-title">${escapeHTML(titleOf(record))}</p><p class="subtle snippet">${escapeHTML(record.action ? `小行动：${record.action} · ${record.followStatus}` : '小行动暂未填写，随时可以补充。')}</p></button>`).join('') : `<div class="footprints empty"><p>${filterDate ? '这一天还没有复盘记录。' : '从一件小事开始'}</p><p class="subtle">保存后的复盘会按日期留在这里，方便回看。</p></div>`;
}
function newRecord() {
  return {id:crypto.randomUUID(),date:localDate(),title:'',...Object.fromEntries(fieldKeys.map(key => [key,''])),status:'draft',step:0,followStatus:'待尝试',effect:'',materials:[],updatedAt:new Date().toISOString()};
}
function revokeURLs() {urls.forEach(url => URL.revokeObjectURL(url)); urls = [];}
function openRecord(record, view = 'step') {
  current = structuredClone(record); revision = 0; dirty = false;
  stepIndex = current.step || 0; saveMessage = records.some(row => row.id === current.id) ? '已保存到当前浏览器' : '填写后会自动保存草稿'; saveError = false;
  if (view === 'follow') renderFollow(); else if (view === 'review') renderReview(); else renderStep();
  if (!dialog.open) dialog.showModal();
  $$resize();
  const firstInput = $('textarea', dialog) || $('input', dialog); if (firstInput) firstInput.focus();
}
function chrome(body, heading, topText) {
  revokeURLs();
  dialog.innerHTML = `<div class="dialog-top"><p class="eyebrow">${escapeHTML(topText)}</p><button class="close" data-do="exit" type="button">保存并退出</button></div><h2 id="step-title" tabindex="-1">${escapeHTML(heading)}</h2>${body}<p class="save-state${saveError ? ' error' : ''}" id="save-state" role="status" aria-live="polite">${escapeHTML(saveMessage)}</p><button class="text-button" data-do="retry" type="button">重试保存</button><button class="secondary" data-do="save-copy" type="button" hidden>另存为新复盘</button>`;
  dialog.scrollTop = 0;
  $('h2', dialog).focus();
  $$resize();
}
function inputField(key, label, type, optional = false) {
  const id = `field-${key}`;
  const control = type === 'textarea' ? `<textarea id="${id}" data-field="${key}" rows="4">${escapeHTML(current[key])}</textarea>` : `<input id="${id}" data-field="${key}" type="${type}" value="${escapeHTML(current[key])}">`;
  return `<label for="${id}">${escapeHTML(label)}${optional ? ' <span class="optional">（可选）</span>' : ''}</label>${control}`;
}
function renderStep() {
  const step = steps[stepIndex];
  chrome(`<div class="progress" aria-label="四步中的第 ${stepIndex+1} 步">${steps.map((_,i) => `<span class="${i <= stepIndex ? 'active' : ''}"></span>`).join('')}</div><p class="hint">${step.hint}</p>${stepIndex === 0 ? inputField('date','记录日期','date') + inputField('title','给这件事起个标题','text',true) : ''}${step.fields.map(([key,label,type]) => inputField(key,label,type)).join('')}<section class="materials"><h3>这一步的关联材料 <span class="optional">（可选）</span></h3><p class="hint">文字笔记、链接或附件，都可以补充这一步的细节。</p><div class="material-tools"><button class="secondary" data-add="note" type="button">添加文字笔记</button><button class="secondary" data-add="link" type="button">添加链接</button><button class="secondary" data-do="files" type="button">添加图片 / 文件</button></div><input class="file-input" id="attachments" type="file" multiple aria-label="选择图片或文件"><p class="attachment-size">单个 ≤ 10 MB · 每条复盘合计 ≤ 30 MB</p><p class="field-error" id="material-feedback" role="alert"></p><div id="material-list"></div></section><div class="editor-nav">${stepIndex > 0 ? '<button class="secondary" data-do="prev" type="button">上一步</button>' : ''}<button class="primary" data-do="next" type="button">${stepIndex === 3 ? '检查并保存' : '下一步'}</button><button class="text-button" data-do="next" type="button">暂时跳过，稍后补充</button></div>`, step.question, `四步中的第 ${stepIndex+1} 步 · ${step.name}`);
  renderMaterials(true);
}
function materialHTML(material, editable) {
  const index = current.materials.indexOf(material);
  const prefix = `material-${index}`;
  const type = {note:'文字笔记',link:'链接',file:'附件'}[material.type];
  let body = '';
  if (material.type === 'note') body = editable ? `<label for="${prefix}-text">笔记内容</label><textarea id="${prefix}-text" data-material="${material.id}" data-prop="text">${escapeHTML(material.text)}</textarea>` : `<p>${escapeHTML(material.text || '暂未填写')}</p>`;
  if (material.type === 'link') {
    const url = validURL(material.text.trim());
    body = editable ? `<label for="${prefix}-text">链接地址（http:// 或 https://）</label><input id="${prefix}-text" type="url" data-material="${material.id}" data-prop="text" value="${escapeHTML(material.text)}">` : (url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(material.text)}</a>` : '<p>链接暂未填写</p>');
  }
  if (material.type === 'file') {
    const imageType = /^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(material.blob.type);
    const url = URL.createObjectURL(new Blob([material.blob], {type:imageType ? material.blob.type : 'application/octet-stream'})); urls.push(url);
    body = `<p>${escapeHTML(material.name)} <span class="subtle">${(material.blob.size/1024).toFixed(1)} KB</span></p>${imageType ? `<img src="${url}" alt="${escapeHTML(material.name)}">` : ''}<a href="${url}" download="${escapeHTML(material.name)}">下载附件</a>${/\.(txt|md|csv|log)$/i.test(material.name) ? `<button class="text-button" data-preview="${material.id}" type="button">查看文字内容</button><pre id="text-${material.id}" hidden></pre>` : ''}`;
  }
  body += editable ? `<label for="${prefix}-caption">这份材料说明什么？（可选）</label><textarea id="${prefix}-caption" data-material="${material.id}" data-prop="caption" rows="2">${escapeHTML(material.caption)}</textarea>` : `<p class="subtle">${escapeHTML(material.caption || '材料说明暂未填写')}</p>`;
  return `<div class="material"><div class="material-head"><span class="material-type">${type} · ${steps[material.step].name}</span>${editable ? `<button class="text-button" data-remove="${material.id}" type="button">移除</button>` : ''}</div>${body}</div>`;
}
function renderMaterials(editable) {
  revokeURLs();
  const list = $('#material-list');
  if (list) list.innerHTML = current.materials.filter(material => material.step === stepIndex).map(material => materialHTML(material, editable)).join('');
  $$resize();
}
function reviewSection(step, index) {
  return `<section class="review-section"><h3>${index+1}. ${step.name}</h3><dl>${step.fields.map(([key,label]) => `<dt>${label}</dt><dd>${escapeHTML(current[key].trim() || '暂未填写')}</dd>`).join('')}</dl>${current.materials.filter(material => material.step === index).map(material => materialHTML(material,false)).join('')}<button class="text-button" data-edit="${index}" type="button">修改${step.name}</button></section>`;
}
function followFields() {
  return `<label for="follow-status">行动状态</label><select id="follow-status" data-field="followStatus">${['待尝试','已尝试','待继续'].map(status => `<option${current.followStatus === status ? ' selected' : ''}>${status}</option>`).join('')}</select>${inputField('effect','尝试后的效果、发现或下次调整','textarea',true)}`;
}
function renderReview() {
  // Generate object URLs after chrome() revokes the previous view's URLs.
  chrome(`<p class="hint">${escapeHTML(current.date)} · 检查一下，未填写的内容可以以后再补充。</p><div id="review-content"></div><div class="editor-nav"><button class="secondary" data-edit="3" type="button">返回修改</button><button class="primary" data-do="finish" type="button">${current.status === 'complete' ? '保存修改' : '完成并保存复盘'}</button></div>`,titleOf(current),'回看这一次复盘');
  $('#review-content').innerHTML = steps.map(reviewSection).join('') + (current.action.trim() ? `<section class="review-section"><h3>行动回访</h3>${followFields()}</section>` : '');
  $$resize();
}
function renderFollow() {
  chrome(`<p class="hint">${escapeHTML(current.date)} · ${escapeHTML(titleOf(current))}</p><div class="card action"><p>${escapeHTML(current.action)}</p><p class="subtle">${escapeHTML(current.when || '尝试时机暂未填写')}</p></div>${followFields()}<div class="editor-nav"><button class="secondary" data-do="review" type="button">查看原复盘</button><button class="primary" data-do="save-follow" type="button">保存回访</button></div>`,'这个小行动，尝试得怎么样？','行动回访');
}
async function closeSaved() {
  if (closing) return;
  closing = true;
  try {if (await saveLatest()) {dialog.close(); current = null; revokeURLs(); toast('已保存，可以随时回来继续。');}}
  finally {closing = false;}
}
async function saveLatest() {do {if (!await persist()) return false;} while (dirty); return true;}
function resize(textarea) {textarea.style.height = 'auto'; textarea.style.height = `${Math.max(textarea.scrollHeight,80)}px`;}
function $$resize() {dialog.querySelectorAll('textarea').forEach(resize);}
dialog.addEventListener('input', event => {
  const target = event.target;
  if (!current) return;
  if (target.dataset.field) {current[target.dataset.field] = target.value; markChanged();}
  if (target.dataset.material) {
    const material = current.materials.find(item => item.id === target.dataset.material);
    material[target.dataset.prop] = target.value; markChanged();
  }
  if (target.tagName === 'TEXTAREA') resize(target);
});
dialog.addEventListener('change', async event => {
  if (event.target.id !== 'attachments') return;
  const files = [...event.target.files];
  const total = current.materials.reduce((sum,item) => sum+(item.blob?.size || 0),0) + files.reduce((sum,file) => sum+file.size,0);
  const tooLarge = files.find(file => file.size > 10*1024*1024);
  if (tooLarge || total > 30*1024*1024) {
    $('#material-feedback').textContent = tooLarge ? `未添加：${tooLarge.name} 超过单个文件 10 MB 的限制。已输入的文字不受影响。` : '未添加：这些附件会使本条复盘超过 30 MB。请选择更小的文件，已输入文字不受影响。';
    event.target.value = ''; return;
  }
  files.forEach(file => current.materials.push({id:crypto.randomUUID(),step:stepIndex,type:'file',name:file.name,blob:file,caption:''}));
  event.target.value = ''; $('#material-feedback').textContent = '';
  if (files.length) {markChanged(); renderMaterials(true); await persist();}
});
dialog.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || !current) return;
  if (closing) return;
  if (button.dataset.add) {
    current.materials.push({id:crypto.randomUUID(),step:stepIndex,type:button.dataset.add,text:'',caption:''});
    markChanged(); renderMaterials(true); const fields = $('#material-list').querySelectorAll('input,textarea'); fields[fields.length-2]?.focus(); return;
  }
  if (button.dataset.remove) {
    if (!window.confirm('要从这条复盘移除这份关联材料吗？源文件不会被修改。')) return;
    current.materials = current.materials.filter(item => item.id !== button.dataset.remove); markChanged(); renderMaterials(true); return;
  }
  if (button.dataset.preview) {
    const material = current.materials.find(item => item.id === button.dataset.preview);
    const preview = document.getElementById(`text-${material.id}`);
    try {preview.textContent = await material.blob.slice(0,100000).text(); preview.hidden = false; if(material.blob.size > 100000) preview.textContent += '\n（仅预览前 100 KB，完整内容请下载。）';} catch {toast('文字预览不可用，请下载附件查看。');} return;
  }
  if (button.dataset.edit !== undefined) {stepIndex = Number(button.dataset.edit); current.step = stepIndex; renderStep(); return;}
  switch (button.dataset.do) {
    case 'files': $('#attachments').click(); break;
    case 'retry': await persist(); break;
    case 'save-copy': current.id = crypto.randomUUID(); current.status = 'draft'; markChanged(); await closeSaved(); break;
    case 'exit': button.disabled = true; await closeSaved(); button.disabled = false; break;
    case 'next':
    case 'prev': {
      if (!current.date) {setSaveState('请填写记录日期，方便以后按日期回看。',true); $('#field-date')?.focus(); return;}
      if (stepIndex === 3 && button.dataset.do === 'next') renderReview();
      else {stepIndex += button.dataset.do === 'next' ? 1 : -1; current.step = stepIndex; markChanged(); renderStep();}
      break;
    }
    case 'review': renderReview(); break;
    case 'save-follow': button.disabled = true; await closeSaved(); button.disabled = false; break;
    case 'finish': {
      if (!fieldKeys.some(key => current[key].trim()) && !current.title.trim() && !current.materials.length) {setSaveState('先写下一点内容，再完成复盘。也可以保存草稿以后继续。',true); return;}
      if (!current.date) {setSaveState('请返回第一步填写记录日期。',true); return;}
      const previous = current.status; current.status = 'complete'; revision++; dirty = true; button.disabled = true; closing = true;
      if (await saveLatest()) {dialog.close(); current = null; revokeURLs(); toast('复盘已保存。把这次发现，留给下一次行动。');}
      else current.status = previous;
      closing = false; button.disabled = false; break;
    }
  }
});
dialog.addEventListener('cancel', event => {event.preventDefault(); closeSaved();});
window.addEventListener('beforeunload', event => {if (dirty) {event.preventDefault(); event.returnValue = '';}});
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button || dialog.contains(button)) return;
  if (button.dataset.open) {const record = records.find(item => item.id === button.dataset.open); if(record) openRecord(record,record.status === 'draft' ? 'step' : 'review');}
  if (button.dataset.follow) {const record = records.find(item => item.id === button.dataset.follow); if(record) openRecord(record,'follow');}
});
$('#start').disabled = true;
$('#start').addEventListener('click', () => {const draft = sortedRecords().find(record => record.date === localDate() && record.status === 'draft'); openRecord(draft || newRecord());});
(async () => {
  try {records = await getRecords(); records.forEach(record => savedVersions.set(record.id,record.updatedAt));}
  catch (error) {
    dbError = error?.message || '读取失败';
    const warning = document.createElement('p'); warning.className = 'home-error'; warning.setAttribute('role','alert'); warning.textContent = '当前浏览器无法读取本地记录。你仍可输入，但暂时不能保存；请保留页面并检查浏览器是否允许网站存储。'; $('.today').before(warning);
  }
  renderHome(); $('#start').disabled = false;
})();
