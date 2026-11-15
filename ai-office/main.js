import { Office, STATUS_TEXT } from './office.js';
import { ManagerSession, generateChatter, friendlyError } from './ai.js';

/* ---------------- 狀態與儲存 ---------------- */
const STORE = 'ai-office-v1';
const MAX_EMPLOYEES = 6;
const DEFAULT = () => ({
  project: 'Wudi Claude',
  apiKey: '',
  model: 'claude-opus-5-5',
  chatter: true,
  stats: { tasks: 0, cost: 0 },
  team: {
    manager: { id: 'boss', name: '主管', role: '主管', color: '#f29bbd', glasses: true },
    employees: [
      { id: 'e1', name: '冠宇', role: '文件專員', skills: ['撰寫文件', '整理會議紀錄', '校稿'], persona: '細心、愛喝咖啡', color: '#4f8cff' },
      { id: 'e2', name: '思妤', role: '前端工程師', skills: ['HTML/CSS', 'JavaScript', 'UI 設計'], persona: '安靜但點子很多', color: '#2fb47c' },
      { id: 'e3', name: '柏翰', role: '資料分析師', skills: ['數據分析', '試算表', '圖表解讀'], persona: '理性、愛講冷笑話', color: '#ff9f43' },
      { id: 'e4', name: '欣怡', role: '行銷企劃', skills: ['文案', '社群貼文', '活動企劃'], persona: '活潑、八卦雷達很強', color: '#c56cf0' },
    ],
  },
});

let state;
try { state = { ...DEFAULT(), ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { state = DEFAULT(); }
const save = () => localStorage.setItem(STORE, JSON.stringify(state));

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a) => a[Math.floor(Math.random() * a.length)];

/* ---------------- 場景與角色 ---------------- */
const office = new Office($('#scene'));
const hour = new Date().getHours();
let night = hour >= 18 || hour < 7;
office.setNight(night);
office.setClock(new Date());

const agents = new Map(); // member.id -> Agent
let agentIndex = 0;

function spawn(member, spot) {
  const a = office.addAgent(member, { index: agentIndex++, onClick: () => openMember(member.id) });
  a.memberId = member.id;
  a.nextIdleAt = performance.now() + 2000 + Math.random() * 6000;
  agents.set(member.id, a);
  if (spot) a.placeAt(spot);
  return a;
}

const boss = spawn(state.team.manager, office.managerSeat);
boss.isBoss = true;

function freeSeat() {
  const used = new Set([...agents.values()].map((a) => a.seat).filter(Boolean));
  return office.seats.find((s) => !used.has(s));
}

state.team.employees.slice(0, MAX_EMPLOYEES).forEach((m, i) => {
  const a = spawn(m);
  a.seat = freeSeat();
  a.placeAt(i % 2 ? rand(office.loungeSpots.filter((s) => !s.sit)) : a.seat);
  // 錯開位置，避免重疊
  if (i % 2) a.group.position.x += (Math.random() - 0.5) * 0.6;
});

const employeeAgents = () => [...agents.values()].filter((a) => !a.isBoss);
const agentByName = (name) => employeeAgents().find((a) => a.member.name === name);
const isFree = (a) => !a.busy && !a.chatting;

/* ---------------- 閒置行為 ---------------- */
setInterval(() => {
  const now = performance.now();
  for (const a of employeeAgents()) {
    if (!isFree(a) || a.path.length || now < a.nextIdleAt) continue;
    a.nextIdleAt = now + 9000 + Math.random() * 12000;
    a.setStatus('idle');
    const r = Math.random();
    if (r < 0.4 && a.seat) a.goTo(a.seat);
    else if (r < 0.7) a.goTo(rand(office.loungeSpots));
    else a.goTo(rand(office.wanderSpots));
    if (Math.random() < 0.2) a.say(rand(['☕ 喝杯咖啡', '伸個懶腰～', '🎵', '去看看書櫃', '有沒有新任務呢？']), 2500);
  }
  office.setClock(new Date());
}, 1000);

/* ---------------- 茶水間閒聊 ---------------- */
const recentEvents = [];
let chatterRunning = false;

async function runChatter() {
  if (chatterRunning || !state.chatter || managerBusy) return;
  const free = employeeAgents().filter(isFree);
  if (free.length < 2) return;
  chatterRunning = true;
  const [a, b] = free.sort(() => Math.random() - 0.5);
  const [sa, sb] = rand(office.chatPairs);
  a.chatting = b.chatting = true;
  const abort = () => !a.chatting || !b.chatting || a.busy || b.busy;
  try {
    await Promise.all([a.goTo(sa), b.goTo(sb)]);
    if (abort()) return;
    a.setStatus('chatting'); b.setStatus('chatting');
    a.say('…', 0);
    let lines;
    try {
      lines = await generateChatter({
        apiKey: state.apiKey, model: state.model, team: state.team, a: a.member, b: b.member,
        recent: recentEvents.slice(-3), onUsage: addCost,
      });
    } catch (err) {
      console.warn('閒聊產生失敗', err);
      lines = [{ speaker: a.member.name, text: '欸，你剛剛說什麼？' }, { speaker: b.member.name, text: '沒事沒事，繼續工作吧 😆' }];
    }
    a.hush();
    logChatterHeader(a.member.name, b.member.name);
    for (const line of lines) {
      if (abort()) break;
      const who = line.speaker === a.member.name ? a : b;
      who.say(line.text, 3300);
      logChatterLine(line.speaker, line.text);
      await sleep(3600);
    }
  } finally {
    for (const x of [a, b]) {
      if (x.chatting) { x.chatting = false; if (!x.busy) x.setStatus('idle'); }
      x.nextIdleAt = performance.now() + 2000 + Math.random() * 4000;
    }
    chatterRunning = false;
  }
}
setTimeout(runChatter, 12000);
setInterval(() => { if (Math.random() < 0.6) runChatter(); }, 40000);

function logChatterHeader(a, b) {
  const box = $('#chatter');
  box.querySelector('.empty')?.remove();
  const d = document.createElement('div');
  d.className = 'sep';
  d.textContent = `— ${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}　${a} × ${b} —`;
  box.appendChild(d);
}
function logChatterLine(name, text) {
  const box = $('#chatter');
  const d = document.createElement('div');
  d.className = 'line';
  const b = document.createElement('b'); b.textContent = name + '：';
  d.append(b, text);
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

/* ---------------- HUD ---------------- */
function addCost(c) { state.stats.cost += c; turnCost += c; renderHud(); save(); }
function renderHud() {
  $('#hud-tasks').textContent = state.stats.tasks;
  $('#hud-cost').textContent = state.stats.cost.toFixed(state.stats.cost < 1 ? 4 : 2);
  const h = new Date().getHours();
  $('#hud-shift').textContent = h >= 19 || h < 8 ? '加班中' : h >= 12 && h < 13 ? '午休中' : '上班中';
  $('#mode-label').textContent = state.apiKey ? `Claude · ${state.model}` : '示範模式（到 ⚙️ 輸入 API Key 啟用 Claude）';
}
renderHud();
setInterval(renderHud, 30000);

$('#btn-cam').onclick = () => office.resetCamera();
$('#btn-light').onclick = () => { night = !night; office.setNight(night); $('#btn-light').textContent = night ? '☀️' : '🌙'; };
$('#btn-light').textContent = night ? '☀️' : '🌙';
$('#btn-labels').onclick = () => $('#scene').classList.toggle('labels-off');
$('#btn-panel').onclick = () => { $('#app').classList.toggle('collapsed'); setTimeout(() => office.resize(), 300); };

/* ---------------- 分頁 ---------------- */
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.tabview').forEach((v) => v.classList.toggle('active', v.id === 'tab-' + t.dataset.tab));
  if (t.dataset.tab === 'team') renderRoster();
}));

/* ---------------- 主管對話 ---------------- */
const session = new ManagerSession();
let managerBusy = false;
let turnCost = 0;

const chat = $('#chat');
function scrollChat() { chat.scrollTop = chat.scrollHeight; }
function showEmpty() {
  chat.innerHTML = `<div class="empty">👋 歡迎來到 AI Office<br>在下方交代工作給主管，<br>主管會分派給小組成員並回報成果。</div>`;
}
showEmpty();

function md(text) {
  const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return esc
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^#{1,6} (.+)$/gm, '<b>$1</b>');
}

function addUser(text) {
  chat.querySelector('.empty')?.remove();
  const d = document.createElement('div');
  d.className = 'msg-user';
  d.textContent = text;
  chat.appendChild(d);
  scrollChat();
}

function addAI() {
  const wrap = document.createElement('div');
  wrap.className = 'msg-ai';
  wrap.innerHTML = `<div class="avatar">✦</div><div class="msg-body"><div class="msg-name"></div><div class="msg-text typing"></div></div>`;
  wrap.querySelector('.msg-name').textContent = state.team.manager.name;
  chat.appendChild(wrap);
  scrollChat();
  let raw = '';
  const el = wrap.querySelector('.msg-text');
  return {
    wrap,
    append(t) { raw += t; el.innerHTML = md(raw.replace(/^\n+/, '')); scrollChat(); },
    get text() { return raw; },
    close() { el.classList.remove('typing'); if (!raw.trim()) wrap.remove(); },
    meta(s) { const m = document.createElement('div'); m.className = 'msg-meta'; m.textContent = s; wrap.querySelector('.msg-body').appendChild(m); },
  };
}

function addActivity(employee, title) {
  const d = document.createElement('details');
  d.className = 'activity';
  d.innerHTML = `<summary><span class="spin"></span><span class="sum"></span></summary><div class="result"></div>`;
  d.querySelector('.sum').textContent = `指派給 ${employee}：${title}`;
  chat.appendChild(d);
  scrollChat();
  return d;
}

const cards = new Map();

async function sendToManager(text) {
  managerBusy = true;
  $('#send').disabled = true;
  addUser(text);
  turnCost = 0;
  const t0 = performance.now();
  let bubble = addAI();
  const snapshot = session.messages.length;
  boss.setStatus('thinking');
  boss.say('嗯…讓我想想', 0);

  const hooks = {
    onThinking() {
      if (!bubble) bubble = addAI();
      boss.setStatus('thinking');
    },
    onText(t) {
      if (!bubble) bubble = addAI();
      bubble.append(t);
      boss.say(bubble.text.replace(/\s+/g, ' ').slice(-38) || '…', 0);
    },
    onAssign({ id, employee, title }) {
      if (bubble) { bubble.close(); bubble = null; }
      cards.set(id, addActivity(employee, title));
      recentEvents.push(`${employee}接到任務「${title}」`);
      boss.setStatus('working');
      boss.say(`${employee}，麻煩你：${title}`, 3000);
      const a = agentByName(employee);
      if (a) assign(a, id, title);
    },
    onResult({ id, employee, result, error }) {
      const card = cards.get(id);
      if (card) {
        card.querySelector('.spin').outerHTML = error ? '<span>⚠️</span>' : '<span>✅</span>';
        card.querySelector('.sum').textContent = error ? `${employee} 失敗：${error}` : `${employee} 交回成果（點開查看）`;
        card.querySelector('.result').textContent = result || error;
        if (error) card.classList.add('error');
      }
      if (!error) { state.stats.tasks++; renderHud(); save(); }
      const a = agentByName(employee);
      if (a) finish(a, id, !error);
    },
    onUsage: addCost,
  };

  try {
    await session.send({ apiKey: state.apiKey, model: state.model, team: state.team, text, hooks });
    if (bubble) bubble.close();
    const last = [...chat.querySelectorAll('.msg-ai')].pop();
    const secs = Math.round((performance.now() - t0) / 1000);
    const meta = `✓ ${secs} 秒` + (state.apiKey ? ` · US$${turnCost.toFixed(4)}` : ' · 示範模式');
    if (last) {
      const m = document.createElement('div'); m.className = 'msg-meta'; m.textContent = meta;
      last.querySelector('.msg-body').appendChild(m);
    }
    boss.say('交代的事都處理好了 👍', 3000);
  } catch (err) {
    console.error(err);
    if (bubble) bubble.close();
    session.messages.length = snapshot; // 丟掉這一輪未完成的訊息，保持對話歷史有效
    const d = document.createElement('div');
    d.className = 'msg-error';
    d.textContent = '⚠️ ' + friendlyError(err);
    chat.appendChild(d);
    scrollChat();
    boss.say('糟糕，出了點問題 😵', 3000);
  } finally {
    managerBusy = false;
    boss.setStatus('idle');
    $('#send').disabled = false;
    $('#input').focus();
  }
}

async function assign(a, id, title) {
  a.busy = { id, title };
  a.chatting = false;
  a.setStatus('walking');
  a.say(`收到！${title}`, 2500);
  const arrived = await a.goTo(a.seat || office.managerVisit);
  if (a.busy?.id !== id) return;
  if (arrived) a.typing = a.sitting;
  a.setStatus('working');
  a.say(`⌨️ ${title}`, 0);
}

async function finish(a, id, ok) {
  if (a.busy?.id !== id) return;
  a.busy = null;
  a.typing = false;
  a.setStatus('idle');
  a.say(ok ? '完成！📄' : '卡住了… 😣', 2500);
  if (!ok) return;
  await sleep(1200);
  if (!isFree(a)) return;
  a.busy = { id: 'report', title: '回報' };
  const arrived = await a.goTo(office.managerVisit);
  if (a.busy?.id === 'report') {
    if (arrived) a.say('報告主管，做好了！', 2500);
    await sleep(2500);
    if (a.busy?.id === 'report') a.busy = null;
  }
  a.nextIdleAt = performance.now() + 1500;
}

const input = $('#input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || managerBusy) return;
  input.value = '';
  input.style.height = 'auto';
  sendToManager(text);
});
$('#btn-clear').onclick = () => {
  if (managerBusy) return;
  session.reset();
  showEmpty();
};

/* ---------------- 小組名單 ---------------- */
function renderRoster() {
  const box = $('#roster');
  box.innerHTML = '';
  const members = [state.team.manager, ...state.team.employees];
  for (const m of members) {
    const a = agents.get(m.id);
    const card = document.createElement('div');
    card.className = 'member';
    const status = a ? (a.busy && a.busy.id !== 'report' ? `${STATUS_TEXT.working}：${a.busy.title}` : STATUS_TEXT[a.status] || '') : '';
    card.innerHTML = `
      <div class="swatch"></div>
      <div class="info"><div class="name"></div><div class="role"></div><div class="skills"></div></div>
      <div class="state"><i class="dot"></i><span></span></div>`;
    card.querySelector('.swatch').style.background = m.color;
    card.querySelector('.swatch').textContent = m.name.slice(0, 1);
    card.querySelector('.name').textContent = m.name;
    card.querySelector('.role').textContent = m.role + (m.persona ? ` · ${m.persona}` : '');
    for (const s of m.skills || []) {
      const c = document.createElement('span'); c.className = 'chip'; c.textContent = s;
      card.querySelector('.skills').appendChild(c);
    }
    card.querySelector('.state .dot').className = 'dot ' + (a?.busy && a.busy.id !== 'report' ? 'working' : a?.status === 'walking' ? 'idle' : a?.status || 'idle');
    card.querySelector('.state span').textContent = status.length > 12 ? status.slice(0, 12) + '…' : status;
    card.onclick = () => openMember(m.id);
    box.appendChild(card);
  }
  if (!$('#chatter').children.length) $('#chatter').innerHTML = '<div class="empty">員工閒下來時會在這裡聊天 ☕</div>';
}
setInterval(() => { if ($('#tab-team').classList.contains('active')) renderRoster(); }, 1500);

let editingId = null;
function openMember(id) {
  editingId = id;
  const isNew = !id;
  const m = id === 'boss' ? state.team.manager : state.team.employees.find((e) => e.id === id) || {};
  $('#member-title').textContent = isNew ? '招募新成員' : id === 'boss' ? '編輯主管' : `編輯 ${m.name}`;
  $('#m-name').value = m.name || '';
  $('#m-role').value = m.role || '';
  $('#m-skills').value = (m.skills || []).join(', ');
  $('#m-persona').value = m.persona || '';
  $('#m-color').value = m.color || '#4f8cff';
  $('#m-delete').style.display = isNew || id === 'boss' ? 'none' : '';
  $('#dlg-member').showModal();
}

$('#btn-hire').onclick = () => {
  if (state.team.employees.length >= MAX_EMPLOYEES) return alert(`辦公室最多只能坐 ${MAX_EMPLOYEES} 位員工喔！`);
  openMember(null);
};

$('#dlg-member').addEventListener('close', () => {
  const v = $('#dlg-member').returnValue;
  if (v === 'delete') return fire(editingId);
  if (v !== 'ok') return;
  const name = $('#m-name').value.trim();
  const role = $('#m-role').value.trim();
  if (!name || !role) return;
  const taken = [state.team.manager, ...state.team.employees].some((e) => e.name === name && e.id !== editingId);
  if (taken) return alert('已經有同名的成員了，換個名字吧！');
  const data = {
    name, role,
    skills: $('#m-skills').value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
    persona: $('#m-persona').value.trim(),
    color: $('#m-color').value,
  };
  if (editingId === 'boss') {
    Object.assign(state.team.manager, data);
    boss.setMember(state.team.manager);
  } else if (editingId) {
    const m = state.team.employees.find((e) => e.id === editingId);
    Object.assign(m, data);
    agents.get(m.id)?.setMember(m);
  } else {
    const m = { id: 'e' + Date.now(), ...data };
    state.team.employees.push(m);
    const a = spawn(m, { x: 8.6, z: -6.2, ry: 0 });
    a.seat = freeSeat();
    a.say(`大家好！我是新來的${role}${name} 🙌`, 3500);
    setTimeout(() => a.seat && a.goTo(a.seat), 1500);
    recentEvents.push(`新同事${name}（${role}）加入了團隊`);
  }
  save();
  renderRoster();
});

function fire(id) {
  const m = state.team.employees.find((e) => e.id === id);
  if (!m || !confirm(`確定要讓 ${m.name} 離開團隊嗎？`)) return;
  const a = agents.get(id);
  if (a) { office.removeAgent(a); agents.delete(id); }
  state.team.employees = state.team.employees.filter((e) => e.id !== id);
  recentEvents.push(`${m.name}離開了團隊`);
  save();
  renderRoster();
}

/* ---------------- 設定 ---------------- */
$('#btn-settings').onclick = () => {
  $('#set-project').value = state.project;
  $('#set-key').value = state.apiKey;
  $('#set-model').value = state.model;
  $('#set-chatter').checked = state.chatter;
  $('#dlg-settings').showModal();
};
$('#dlg-settings').addEventListener('close', () => {
  if ($('#dlg-settings').returnValue !== 'ok') return;
  state.project = $('#set-project').value.trim() || state.project;
  state.apiKey = $('#set-key').value.trim();
  state.model = $('#set-model').value;
  state.chatter = $('#set-chatter').checked;
  state.team.project = state.project;
  save();
  renderHud();
});

state.team.project = state.project;
if (!state.apiKey) {
  setTimeout(() => boss.say('歡迎！有工作就交給我吧 😊', 4000), 1200);
}

// 方便除錯
window.aiOffice = { office, agents, state, session };
