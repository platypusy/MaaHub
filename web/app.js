'use strict';
/* MaaHub 前端：纯原生 JS，无框架。所有数据通过 window.pywebview.api 与 Python 后台交互。 */

const api = () => window.pywebview.api;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  apps: [], kinds: {}, settings: {}, running: {}, seq: null, now: Date.now() / 1000,
  page: 'home', detailId: null, lastEvt: 0, sig: '', version: '', config: '',
  log: { appId: null, files: [], path: null, lines: [], truncated: false, level: 'all', q: '', follow: true },
};

const NAV = [
  { id: 'home', icon: 'grid', label: '首页' },
  { id: 'seq', icon: 'route', label: '顺序执行' },
  { id: 'logs', icon: 'terminal', label: '日志' },
  { id: 'settings', icon: 'settings', label: '设置' },
];
const PRESET_COLORS = ['#7c8cff', '#38bdf8', '#34d399', '#a3e635', '#facc15', '#fb923c', '#f87171', '#f472b6', '#c084fc', '#94a3b8'];
const STEP_LABEL = { wait: '等待中', launching: '启动中', running: '运行中', done: '已完成', fail: '失败', cancel: '已取消' };
const STEP_ICON = { wait: '', launching: '', running: 'activity', done: 'check', fail: 'x', cancel: 'x' };

/* ============================================================ 工具函数 */
const appById = id => S.apps.find(a => a.id === id);
const isRunning = id => !!S.running[id];

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  return `${Math.floor(sec / 3600)} 小时 ${Math.floor(sec % 3600 / 60)} 分`;
}
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s).padStart(2, '0');
}
function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000), now = new Date();
  const hm = d.toTimeString().slice(0, 5);
  const day = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (day === 0) return `今天 ${hm}`;
  if (day === 1) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}
function onAccent(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return '#fff';
  const [r, g, b] = m.slice(1).map(x => parseInt(x, 16) / 255);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.62 ? '#14161d' : '#fff';
}
const accentStyle = a => `--accent:${a.accent};--on-accent:${onAccent(a.accent)}`;
function appIcon(a, cls) {
  return a.icon ? `<img class="${cls}" src="${a.icon}" alt="">`
    : `<div class="${cls === 'cover-icon' ? 'cover-fallback' : 'fb'}">${esc((a.name || '?').slice(0, 1))}</div>`;
}
function versionText(a) {
  return (a.versions && a.versions[0] && a.versions[0].value) || '';
}
function selectedConfig(a) {
  const cs = a.configs || [];
  return cs.find(c => c.value === a.profile) || cs.find(c => c.current) || cs[0] || null;
}
async function call(fn, ...args) {
  try { return await api()[fn](...args); }
  catch (e) { toast('error', (e && e.message) || String(e)); throw e; }
}

/* ============================================================ 主题 */
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = S.settings.theme || 'system';
  const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme-btn').innerHTML = icon(pref === 'system' ? 'monitor' : dark ? 'moon' : 'sun') +
    `<span>${pref === 'system' ? '跟随系统' : dark ? '深色' : '浅色'}</span>`;
  api().set_title_theme(dark);
}
darkQuery.addEventListener('change', () => S.apps.length && applyTheme());
async function setTheme(t) {
  S.settings.theme = t;
  applyTheme();
  await call('set_setting', 'theme', t);
  if (S.page === 'settings') render();
}
function setGlow(color) {
  document.documentElement.style.setProperty('--accent-glow', color || 'var(--primary)');
}

/* ============================================================ 初始化与轮询 */
window.addEventListener('pywebviewready', init);

async function init() {
  const b = await api().bootstrap();
  Object.assign(S, { apps: b.apps, kinds: b.kinds, settings: b.settings || {}, version: b.version, config: b.config_path, isAdmin: b.is_admin });
  const st = await api().state(0);
  S.lastEvt = Math.max(st.now, ...st.events.map(e => e.t));
  applyState(st);
  applyTheme();
  render();
  setTimeout(poll, 1500);
  setInterval(tick, 1000);
  setInterval(logTick, 2000);
}

function applyState(st) {
  S.running = st.running || {};
  S.seq = st.seq;
  S.now = st.now;
  S.clockSkew = Date.now() / 1000 - st.now;
}

async function reloadApps() {
  const b = await api().bootstrap();
  S.apps = b.apps;
}

async function poll() {
  try {
    const st = await api().state(S.lastEvt);
    for (const e of st.events) { toast(e.kind, e.text); S.lastEvt = Math.max(S.lastEvt, e.t); }
    const oldRunning = Object.keys(S.running).sort().join();
    applyState(st);
    const newRunning = Object.keys(S.running).sort().join();
    const cur = Object.entries(S.running).map(([k, v]) => k + ':' + (v.current || '')).sort().join();
    const sig = newRunning + '|' + cur + '|' + JSON.stringify(S.seq);
    if (sig !== S.sig) {
      S.sig = sig;
      if (oldRunning !== newRunning) await reloadApps();   // 运行记录可能变了
      if (S.page !== 'logs') render(true);
      else renderNav();
    }
  } catch (e) { console.error(e); }
  setTimeout(poll, 1500);
}

function tick() {
  const now = Date.now() / 1000 - (S.clockSkew || 0);
  $$('[data-since]').forEach(el => { el.textContent = fmtClock(now - Number(el.dataset.since)); });
}

/* ============================================================ 渲染 */
function renderNav() {
  const anyRun = Object.keys(S.running).length > 0;
  const seqOn = S.seq && S.seq.active;
  $('#nav').innerHTML = NAV.map(n => `
    <button class="nav-btn ${S.page === n.id || (n.id === 'home' && S.page === 'detail') ? 'active' : ''}" data-act="nav" data-page="${n.id}">
      ${icon(n.icon)}<span>${n.label}</span>
      ${(n.id === 'home' && anyRun) || (n.id === 'seq' && seqOn) ? '<i class="badge"></i>' : ''}
    </button>`).join('');
}

function render(keepScroll) {
  const main = $('#main');
  const top = main.scrollTop;
  renderNav();
  let html = '';
  if (S.page === 'home') html = pageHome();
  else if (S.page === 'detail') html = pageDetail();
  else if (S.page === 'seq') html = pageSeq();
  else if (S.page === 'logs') html = pageLogs();
  else if (S.page === 'settings') html = pageSettings();
  main.innerHTML = html;
  if (keepScroll) { main.scrollTop = top; $$('.page', main).forEach(p => p.style.animation = 'none'); }
  else main.scrollTop = 0;
  setGlow(S.page === 'detail' ? appById(S.detailId)?.accent : null);
  afterRender();
  tick();
}

function afterRender() {
  if (S.page === 'detail') { loadMiniLog(); loadActivity(); }
  if (S.page === 'seq') bindDrag();
  if (S.page === 'logs') { renderLogBody(true); }
}

function go(page, id) {
  closeModal();
  $('#menu-root').innerHTML = '';
  S.page = page;
  if (id !== undefined) S.detailId = id;
  if (page === 'logs' && id) S.log.appId = id;
  render();
  if (page === 'logs') openLogPage();
}

/* ---------------------------------------------------------- 首页 */
function pageWelcome() {
  const steps = [
    ['scan', '扫描文件夹', '选中存放自动化程序的文件夹（例如 D:\\Games），MaaHub 会找出其中的 MAA 系程序，可一次性全部添加。'],
    ['plus', '或者手动添加', '选择某个程序的安装目录，类型、主程序、名称都会自动识别。任何 exe 都能以“通用程序”加入。'],
    ['play', '开始使用', '在卡片上一键启动；详情页可选配置、查看任务清单和实时运行动态。'],
  ];
  return `<div class="page">
    <div class="welcome card">
      <div class="welcome-art">${icon('layers')}</div>
      <h1>欢迎使用 MaaHub</h1>
      <div class="lead">把 MAA、M9A、MaaEnd 等游戏自动化脚本集中到一处：统一启动、查看配置与任务、追踪运行进度。<br>目前还没有添加任何程序，先从下面开始吧。</div>
      <div class="row" style="justify-content:center;margin-top:22px">
        <button class="btn lg primary" data-act="scan">${icon('scan')}扫描文件夹</button>
        <button class="btn lg" data-act="add">${icon('plus')}手动添加</button>
      </div>
    </div>
    <div class="welcome-steps">
      ${steps.map(([ic, t, d], i) => `<div class="card card-pad">
        <div class="row"><span class="q-num">${i + 1}</span><span class="opt-ic">${icon(ic)}</span><h2>${t}</h2></div>
        <div class="muted" style="margin-top:10px;line-height:1.7;font-size:13.5px">${d}</div></div>`).join('')}
    </div>
    <div class="hint" style="justify-content:center">${icon('info')}<span>支持：MAA 官方界面、MFAAvalonia（如 M9A）、MXU（如 MaaEnd）三类界面，以及任意通用程序。</span></div>
  </div>`;
}

function pageHome() {
  if (!S.apps.length) return pageWelcome();
  const runningApps = S.apps.filter(a => isRunning(a.id));
  const todayStart = new Date(new Date().toDateString()) / 1000;
  const todayRuns = S.apps.reduce((n, a) => n + (a.last_run && a.last_run.start >= todayStart ? 1 : 0), 0)
    + runningApps.length;
  const seqApps = S.apps.filter(a => a.in_sequence);
  let seqText = `${seqApps.length} 个已勾选`;
  if (S.seq && S.seq.active) {
    const done = S.seq.steps.filter(s => ['done', 'fail'].includes(s.state)).length;
    seqText = `进行中 ${done}/${S.seq.steps.length}`;
  }
  return `<div class="page">
    <div class="page-head">
      <div class="grow">
        <h1>${greeting()}</h1>
        <div class="lead">${S.apps.length} 个自动化程序${runningApps.length ? ` · <b style="color:var(--success)">${runningApps.length} 个正在运行</b>` : ' · 都在休息'}</div>
      </div>
      <button class="btn" data-act="scan">${icon('scan')}扫描文件夹</button>
      <button class="btn primary" data-act="add">${icon('plus')}添加应用</button>
    </div>

    <div class="stats">
      <div class="card stat"><div class="stat-ic tint-green">${icon('activity')}</div>
        <div><div class="stat-v">${runningApps.length}</div><div class="stat-l">正在运行</div></div></div>
      <div class="card stat"><div class="stat-ic tint-blue">${icon('clock')}</div>
        <div><div class="stat-v">${todayRuns}</div><div class="stat-l">今日运行</div></div></div>
      <div class="card stat" data-act="nav" data-page="seq" style="cursor:pointer"><div class="stat-ic tint-violet">${icon('route')}</div>
        <div><div class="stat-v" style="font-size:18px">${seqText}</div><div class="stat-l">顺序执行队列</div></div></div>
    </div>

    <div class="section-t"><h2>我的应用</h2></div>
    <div class="grid">
      ${S.apps.map(appCard).join('')}
      <button class="add-card" data-act="add"><div class="circle">${icon('plus')}</div>添加新的自动化程序</button>
    </div>
  </div>`;
}

function appCard(a) {
  const run = S.running[a.id];
  const last = run
    ? `${icon('activity')}<span>${run.current ? `正在 <b>${esc(run.current)}</b> · ` : ''}已运行 <b data-since="${run.since || S.now}"></b></span>`
    : a.last_run ? `${icon('clock')}<span>上次 ${fmtWhen(a.last_run.start)} · ${fmtDur(a.last_run.end - a.last_run.start)}</span>`
      : `${icon('clock')}<span>还没有运行记录</span>`;
  return `<div class="app-card" style="${accentStyle(a)}" data-act="open" data-id="${a.id}">
    <div class="cover">
      ${a.icon ? `<img class="cover-blur" src="${a.icon}" alt="">` : ''}
      ${appIcon(a, 'cover-icon')}
      <span class="pill ${run ? 'on' : ''}"><i class="dot"></i>${run ? '运行中' : '未运行'}</span>
    </div>
    <div class="card-body">
      <div class="card-title">${esc(a.name)}</div>
      <div class="card-sub">${esc(a.subtitle || a.kind_label)}</div>
      <div class="tags">
        <span class="tag accent">${esc(a.kind_label)}</span>
        ${versionText(a) ? `<span class="tag">${esc(versionText(a))}</span>` : ''}
        ${selectedConfig(a) ? `<span class="tag">${icon('layers')}${esc(selectedConfig(a).label)}</span>` : ''}
        ${!a.exists ? `<span class="tag" style="color:var(--danger)">${icon('alert')}程序不存在</span>` : ''}
      </div>
    </div>
    <div class="card-foot">
      <div class="last">${last}</div>
      <button class="play ${run ? 'stop' : ''}" data-act="toggle" data-id="${a.id}" title="${run ? '停止' : '启动'}">
        ${icon(run ? 'stop' : 'play')}</button>
    </div>
  </div>`;
}

/* ---------------------------------------------------------- 详情页 */
function pageDetail() {
  const a = appById(S.detailId);
  if (!a) { S.page = 'home'; return pageHome(); }
  const k = a.kind_info || {};
  const run = S.running[a.id];
  return `<div class="page" style="${accentStyle(a)}">
    <section class="hero" style="${accentStyle(a)}">
      ${a.icon ? `<img class="hero-blur" src="${a.icon}" alt=""><img class="hero-art" src="${a.icon}" alt="">` : ''}
      <div class="hero-top">
        <button class="icon-btn glass" data-act="nav" data-page="home" title="返回">${icon('back')}</button>
        <div class="spacer"></div>
        <button class="icon-btn glass" data-act="menu" data-id="${a.id}" title="更多">${icon('more')}</button>
      </div>
      <div class="hero-main">
        <h1>${esc(a.name)} <span class="pill ${run ? 'on' : ''}"><i class="dot"></i>${run ? '运行中' : '未运行'}</span></h1>
        <div class="sub">${esc(a.subtitle || '')}</div>
        <div class="tags">
          <span class="tag">${esc(a.kind_label)}</span>
          ${(a.versions || []).map(x => `<span class="tag" title="${esc(x.note)}">${esc(x.label)} ${esc(x.value)}</span>`).join('')}
          ${a.admin ? `<span class="tag">${icon('shield')}管理员</span>` : ''}
        </div>
        <div class="hero-actions">
          ${run
            ? `<button class="btn lg danger" data-act="stop" data-id="${a.id}">${icon('stop')}停止运行</button>
               <span class="hero-run">${icon('activity')}${run.current ? `正在 <b>${esc(run.current)}</b> · ` : ''}已运行 <b data-since="${run.since || S.now}"></b>${run.locked ? ' · 管理员权限' : ''}</span>`
            : `<button class="btn lg accent" data-act="launch" data-id="${a.id}" ${a.exists ? '' : 'disabled'}>${icon('play')}开始运行</button>
               ${!a.exists ? `<span class="hero-run" style="color:var(--danger)">${icon('alert')}找不到 ${esc(a.exe)}</span>` : ''}`}
          <button class="btn ghost" data-act="folder" data-id="${a.id}">${icon('folder')}打开目录</button>
        </div>
      </div>
    </section>

    <div class="detail-grid">
      <div class="stack">
        <div class="card card-pad">
          <div class="card-h">${icon('settings')}<h2>启动选项</h2></div>
          ${k.profile ? profileChips(a, k) : ''}
          ${optRow(a, 'autorun', 'zap', '启动后自动执行任务', a.kind === 'maa_wpf' ? '关闭时会跳过 MAA 的“启动后直接运行”' : '以自动模式启动，直接开始所选实例的任务', !k.autorun)}
          ${optRow(a, 'quit_after', 'check', '任务完成后自动退出', k.quit ? '配合顺序执行使用，退出后自动轮到下一个' : '请在该程序自己的设置中开启', !k.quit || (a.kind === 'mxu' && !a.autorun))}
          ${optRow(a, 'in_sequence', 'route', '加入顺序执行队列', '在“顺序执行”页面统一按顺序运行')}
          ${optRow(a, 'admin', 'shield', '以管理员身份运行', '部分游戏的 PC 端需要，启动时会弹出 UAC 确认')}
          <details class="adv">
            <summary>${icon('chevron')}高级选项</summary>
            <div class="form-row" style="margin-top:12px">
              <label>额外启动参数</label>
              <input class="input" data-field="extra_args" data-id="${a.id}" value="${esc(a.extra_args || '')}" placeholder="例如 --debug（按回车保存）">
            </div>
            <div class="field-l">实际执行的命令</div>
            <div class="code">${esc(a.command)}</div>
            <div class="hint">${icon('info')}<span>${esc(k.hint || '')}</span></div>
          </details>
        </div>
        ${taskCard(a)}
      </div>

      <div class="stack">
        <div class="card card-pad">
          <div class="card-h">${icon('activity')}<h2>${run ? '运行动态' : '上次运行动态'}</h2><div class="spacer"></div>
            <span class="faint" style="font-size:12px" id="act-src"></span></div>
          <div id="activity"><div class="faint">读取中…</div></div>
        </div>
        <div class="card card-pad">
          <div class="card-h">${icon('clock')}<h2>运行记录</h2></div>
          ${historyBlock(a)}
        </div>
        <div class="card card-pad">
          <div class="card-h">${icon('terminal')}<h2>最新日志</h2><div class="spacer"></div>
            <button class="btn ghost" style="height:32px" data-act="open-logs" data-id="${a.id}">查看全部 ${icon('chevronR')}</button></div>
          <div class="mini-log" id="mini-log"><div class="faint">读取中…</div></div>
        </div>
      </div>
    </div>
  </div>`;
}

function profileChips(a, k) {
  const cs = a.configs || [];
  const cur = cs.find(c => c.current);
  const chip = (value, label, extra = '') => {
    const on = (a.profile || '') === value;
    return `<button class="chip ${on ? 'on' : ''}" data-act="profile" data-id="${a.id}" data-v="${esc(value)}">${on ? icon('check') : ''}${label}${extra}</button>`;
  };
  return `<div class="field-l">${esc(k.profile)}<span class="faint">· 读取自软件配置</span></div>
    <div class="chips">
      ${chip('', '跟随软件', cur ? `<span class="count">${esc(cur.label)}</span>` : '')}
      ${cs.map(c => chip(c.value, esc(c.label), c.current ? '<span class="count">上次使用</span>' : '')).join('')}
      ${a.profile && !cs.some(c => c.value === a.profile) ? chip(a.profile, esc(a.profile), '<span class="count" style="color:var(--danger)">已不存在</span>') : ''}
    </div>
    <div style="height:12px"></div>`;
}

function taskCard(a) {
  const c = selectedConfig(a);
  if (!c) return '';
  const all = c.groups.flatMap(g => g.tasks);
  const on = all.filter(t => t.enabled).length;
  return `<div class="card card-pad">
    <div class="card-h">${icon('layers')}<h2>「${esc(c.label)}」的任务</h2><div class="spacer"></div>
      <span class="tag accent">已勾选 ${on} / ${all.length}</span></div>
    ${c.groups.length ? c.groups.map(g => `
      ${c.groups.length > 1 || g.title !== '任务队列' ? `<div class="field-l" style="margin-top:4px">${esc(g.title)}</div>` : ''}
      <div class="task-list">${g.tasks.map(t => `
        <div class="task ${t.enabled ? 'on' : ''}">
          <span class="task-ck">${t.enabled ? icon('check') : ''}</span>
          <span class="task-n" title="${esc(t.name)}">${esc(t.name)}</span>
          ${t.detail ? `<span class="task-d" title="${esc(t.detail)}">${esc(t.detail)}</span>` : ''}
        </div>`).join('')}</div>`).join('')
      : '<div class="faint">这套配置里没有读到任务列表</div>'}
    <div class="hint">${icon('info')}<span>直接读取自 ${esc(a.name)} 的配置文件，只读显示。要增删任务或调整参数，请在 ${esc(a.name)} 里修改，这里会自动同步。</span></div>
  </div>`;
}

const ACT_ICON = { start: 'play', done: 'check', fail: 'x', stop: 'stop', all: 'check', boot: 'zap' };
async function loadActivity() {
  const a = appById(S.detailId);
  const box = $('#activity');
  if (!a || !box) return;
  let r;
  try { r = await api().activity(a.id); } catch (e) { box.innerHTML = `<div class="faint">读取失败：${esc(e.message || e)}</div>`; return; }
  if (S.page !== 'detail' || S.detailId !== a.id || !$('#activity')) return;
  $('#act-src').textContent = r.source ? `来自 ${r.source}` : '';
  const run = S.running[a.id];
  const evs = r.events.slice().reverse().slice(0, 14);
  box.innerHTML = (run ? `<div class="now-task">${icon('activity')}<div><small>当前任务</small><b>${esc(r.current || '等待软件开始任务…')}</b></div></div>` : '') +
    (evs.length ? `<div class="act-list">${evs.map(e => `
      <div class="act ${e.kind}"><span class="act-ic">${icon(ACT_ICON[e.kind] || 'info')}</span>
        <span class="act-t">${esc(e.text)}</span><span class="act-tm">${new Date(e.t * 1000).toTimeString().slice(0, 8)}</span></div>`).join('')}</div>`
      : `<div class="bars-empty" style="height:auto;padding:18px;text-align:center;line-height:1.7">${run ? '软件已启动，开始执行任务后这里会实时显示每个任务的进度' : '最近一次运行中没有任务记录'}</div>`);
}

function optRow(a, field, ic, title, desc, disabled) {
  return `<div class="opt-row ${disabled ? 'disabled' : ''}">
    <div class="opt-ic">${icon(ic)}</div>
    <div class="opt-txt"><div class="opt-t">${title}</div><div class="opt-d">${desc}</div></div>
    <label class="switch"><input type="checkbox" data-field="${field}" data-id="${a.id}" ${a[field] ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span></span></label>
  </div>`;
}

function historyBlock(a) {
  const h = a.history || [];
  const last = a.last_run;
  const total = h.reduce((s, r) => s + (r.end - r.start), 0);
  const recent = h.slice(-16);
  const max = Math.max(1, ...recent.map(r => r.end - r.start));
  return `<div class="kv">
      <div><small>上次运行</small><b>${last ? fmtWhen(last.start).replace(/ .*/, '') : '—'}</b></div>
      <div><small>上次用时</small><b>${last ? fmtDur(last.end - last.start) : '—'}</b></div>
      <div><small>累计次数</small><b>${a.run_count || 0}</b></div>
    </div>
    ${recent.length
      ? `<div class="bars">${recent.map(r => `<i style="height:${Math.max(8, (r.end - r.start) / max * 100)}%" title="${fmtWhen(r.start)} · ${fmtDur(r.end - r.start)}"></i>`).join('')}</div>
         <div class="faint" style="font-size:12px;margin-top:8px">最近 ${recent.length} 次运行时长 · 累计 ${fmtDur(total)}</div>`
      : `<div class="bars-empty">通过 MaaHub 运行后，这里会显示每次的运行时长</div>`}`;
}

async function loadMiniLog() {
  const a = appById(S.detailId);
  const box = $('#mini-log');
  if (!a || !box) return;
  try {
    const files = await api().logs(a.id);
    if (!files.length) { box.innerHTML = '<div class="faint">没有找到日志文件</div>'; return; }
    const r = await api().read_log(files[0].path);
    if (S.page !== 'detail' || S.detailId !== a.id) return;
    const lines = r.lines.filter(l => l[0] !== 'debug').slice(-9);
    box.innerHTML = `<div class="faint" style="font-family:var(--font);font-size:12px;margin-bottom:4px">${esc(files[0].name)} · ${fmtWhen(files[0].mtime)}</div>` +
      (lines.length ? lines.map(([lv, t]) => { const p = parseLine(t); return `<div class="ln lv-${lv}" style="padding:0"><span class="tx">${p.time ? `<span class="faint">${esc(p.time)}</span> ` : ''}${esc(p.msg)}</span></div>`; }).join('')
        : '<div class="faint">日志为空</div>');
  } catch (e) { box.innerHTML = `<div class="faint">读取失败：${esc(e.message || e)}</div>`; }
}

/* ---------------------------------------------------------- 顺序执行 */
function pageSeq() {
  const seq = S.seq;
  const active = seq && seq.active;
  const steps = seq ? seq.steps : S.apps.filter(a => a.in_sequence).map(a => ({ id: a.id, name: a.name, state: 'wait' }));
  const done = steps.filter(s => ['done', 'fail', 'cancel'].includes(s.state)).length;
  const pct = steps.length ? Math.round(done / steps.length * 100) : 0;
  return `<div class="page">
    <div class="page-head">
      <div class="grow">
        <h1>顺序执行</h1>
        <div class="lead">按顺序依次启动，前一个程序退出后再启动下一个。适合共用同一台模拟器或电脑的多个脚本。</div>
      </div>
      ${active
        ? `<button class="btn lg danger" data-act="seq-cancel">${icon('stop')}取消执行</button>`
        : `<button class="btn lg primary" data-act="seq-start" ${S.apps.some(a => a.in_sequence) ? '' : 'disabled'}>${icon('play')}开始顺序执行</button>`}
    </div>
    <div class="seq-grid">
      <div class="card card-pad">
        <div class="card-h">${icon('layers')}<h2>执行队列</h2><div class="spacer"></div><span class="faint" style="font-size:12.5px">拖动排序</span></div>
        <div id="queue">
          ${S.apps.map((a, i) => `
            <div class="q-item ${a.in_sequence ? '' : 'off'}" draggable="${active ? 'false' : 'true'}" data-id="${a.id}" style="${accentStyle(a)}">
              <span class="q-grip">${icon('grip')}</span>
              <span class="q-num">${i + 1}</span>
              ${a.icon ? `<img class="q-icon" src="${a.icon}" alt="">` : ''}
              <div class="q-txt"><b>${esc(a.name)}</b><small>${esc(a.profile ? `${a.kind_info.profile || '配置'}：${a.profile}` : a.kind_label)}${a.quit_after || a.kind !== 'mxu' ? '' : ' · 未开启完成后退出'}</small></div>
              <label class="switch"><input type="checkbox" data-field="in_sequence" data-id="${a.id}" ${a.in_sequence ? 'checked' : ''} ${active ? 'disabled' : ''}><span></span></label>
            </div>`).join('')}
        </div>
        <div class="hint">${icon('info')}<span>请确保每个程序都设置为“启动后自动执行”并“完成后退出”，否则需要手动关闭它，队列才会继续。60 秒内没检测到程序启动会记为失败并跳过。</span></div>
      </div>
      <div class="card card-pad">
        <div class="card-h">${icon('activity')}<h2>${seq ? (active ? '正在执行' : '上次执行') : '执行预览'}</h2><div class="spacer"></div>
          ${seq ? `<span class="faint" style="font-size:12.5px">${fmtWhen(seq.started)} 开始${seq.finished ? ` · 用时 ${fmtDur(seq.finished - seq.started)}` : ''}</span>` : ''}</div>
        ${seq ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
        ${steps.length ? `<div class="timeline">${steps.map(stepRow).join('')}</div>`
          : `<div class="empty">${icon('route')}<div>队列为空，在左侧打开要执行的应用</div></div>`}
      </div>
    </div>
  </div>`;
}

function stepRow(s) {
  const a = appById(s.id) || { accent: '#888', name: s.name };
  let meta = '';
  if (s.state === 'running' || s.state === 'launching') meta = `开始于 ${fmtWhen(s.start)} · 已运行 <b data-since="${s.start}"></b>`;
  else if (s.start && s.end) meta = `${fmtWhen(s.start)} · 用时 ${fmtDur(s.end - s.start)}`;
  if (s.note) meta += (meta ? ' · ' : '') + esc(s.note);
  return `<div class="t-step ${s.state}" style="${accentStyle(a)}">
    <div class="t-dot">${STEP_ICON[s.state] ? icon(STEP_ICON[s.state]) : ''}</div>
    <div class="t-body"><b>${esc(a.name || s.name)}</b><span class="t-state">${STEP_LABEL[s.state]}</span>
      ${meta ? `<div class="t-meta">${meta}</div>` : ''}</div>
  </div>`;
}

function bindDrag() {
  let dragId = null;
  $$('#queue .q-item').forEach(el => {
    el.addEventListener('dragstart', e => { dragId = el.dataset.id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); $$('.q-item.over').forEach(x => x.classList.remove('over')); });
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', async e => {
      e.preventDefault();
      const target = el.dataset.id;
      if (!dragId || dragId === target) return;
      const ids = S.apps.map(a => a.id).filter(i => i !== dragId);
      const before = ids.indexOf(target);
      const fromIdx = S.apps.findIndex(a => a.id === dragId), toIdx = S.apps.findIndex(a => a.id === target);
      ids.splice(fromIdx < toIdx ? before + 1 : before, 0, dragId);
      S.apps.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
      render(true);
      await call('reorder', ids);
    });
  });
}

/* ---------------------------------------------------------- 日志页 */
function pageLogs() {
  const L = S.log;
  const counts = levelCounts();
  const a = appById(L.appId);
  return `<div class="page log-page">
    <div class="page-head"><div class="grow"><h1>日志</h1><div class="lead">查看各程序的运行日志，自动刷新最新内容。</div></div></div>
    <div class="app-tabs">
      ${S.apps.map(x => `<button class="app-tab ${x.id === L.appId ? 'on' : ''}" style="${accentStyle(x)}" data-act="log-app" data-id="${x.id}">
        ${x.icon ? `<img src="${x.icon}" alt="">` : `<span class="fb">${esc(x.name.slice(0, 1))}</span>`}${esc(x.name)}
        ${isRunning(x.id) ? '<span class="pill on" style="height:8px;width:8px;padding:0;background:none"><i class="dot"></i></span>' : ''}</button>`).join('')}
    </div>
    <div class="log-tools" style="${a ? accentStyle(a) : ''}">
      <select class="input" style="width:auto;min-width:220px;max-width:360px" data-act-change="log-file">
        ${L.files.length ? L.files.map(f => `<option value="${esc(f.path)}" ${f.path === L.path ? 'selected' : ''}>${esc(f.name)}（${fmtSize(f.size)}，${fmtWhen(f.mtime)}）</option>`).join('')
          : '<option>没有找到日志文件</option>'}
      </select>
      <div class="chips" id="lv-chips">${lvChips(counts)}</div>
      <div class="spacer"></div>
      <div class="search">${icon('search')}<input class="input" id="log-q" placeholder="搜索日志…" value="${esc(L.q)}"></div>
      <label class="row" style="gap:8px;font-size:13px;color:var(--text-2);cursor:pointer">
        <span class="switch" style="width:40px;height:24px"><input type="checkbox" id="log-follow" ${L.follow ? 'checked' : ''}><span></span></span>自动刷新</label>
      <button class="icon-btn" data-act="log-external" title="用记事本打开">${icon('external')}</button>
    </div>
    <div class="log-box" id="log-box"></div>
  </div>`;
}

function levelCounts() {
  const c = { all: S.log.lines.length, debug: 0, info: 0, warn: 0, error: 0 };
  S.log.lines.forEach(([lv]) => { c[lv]++; });
  return c;
}
function lvChips(counts) {
  const L = S.log;
  return [['all', '全部'], ['debug', '调试'], ['info', '信息'], ['warn', '警告'], ['error', '错误']].map(([k, t]) =>
    `<button class="chip ${L.level === k ? 'on' : ''}" data-act="log-level" data-v="${k}">${t}<span class="count">${counts[k]}</span></button>`).join('');
}

const LINE_RE = /^\[(?:\d{4}-\d\d-\d\d\s+)?(\d\d:\d\d:\d\d)(?:\.\d+)?\]\s*\[([A-Za-z]{1,5})\]((?:\s*\[[^\]]*\])*)\s*(.*)$/;
const LINE_RE2 = /^(?:\d{4}-\d\d-\d\d[ T])?(\d\d:\d\d:\d\d)(?:[.,]\d+)?\s*\[?([A-Za-z]{3,5})\]?\s*(.*)$/;
function parseLine(t) {
  let m = LINE_RE.exec(t);
  if (m) {
    const src = (m[3] || '').trim().replace(/\[(Px|Tx)\d+\]/g, '').trim();
    return { time: m[1], lvl: m[2].toUpperCase(), src, msg: m[4] || '' };
  }
  m = LINE_RE2.exec(t);
  if (m) return { time: m[1], lvl: m[2].toUpperCase(), src: '', msg: m[3] };
  return { time: '', lvl: '', src: '', msg: t };
}
const LV_TEXT = { info: 'INFO', warn: 'WARN', error: 'ERR', debug: 'DBG' };

function renderLogBody(scrollEnd) {
  const box = $('#log-box');
  if (!box) return;
  const L = S.log;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const q = L.q.trim().toLowerCase();
  const qre = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig') : null;
  const hl = s => { const e = esc(s); return qre ? e.replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), m => `<mark>${m}</mark>`) : e; };
  const out = [];
  L.lines.forEach(([lv, t], i) => {
    if (L.level !== 'all' && lv !== L.level) return;
    if (qre && !t.toLowerCase().includes(q)) return;
    const p = parseLine(t);
    out.push(`<div class="ln lv-${lv}"><span class="no">${i + 1}</span>${p.time ? `<span class="tm">${p.time}</span>` : ''}<span class="lv">${LV_TEXT[lv]}</span><span class="tx">${p.src ? `<span class="src">${hl(p.src)} </span>` : ''}${hl(p.msg)}</span></div>`);
  });
  box.innerHTML = (L.truncated ? '<div class="log-note">…… 只显示文件末尾的部分内容，完整日志请用记事本打开</div>' : '') +
    (out.length ? out.join('') : `<div class="empty">${icon('file')}<div>${L.lines.length ? '没有符合条件的日志' : '日志为空'}</div></div>`);
  if (scrollEnd || atBottom) box.scrollTop = box.scrollHeight;
  const chips = $('#lv-chips');
  if (chips) chips.innerHTML = lvChips(levelCounts());
}

async function openLogPage() {
  const L = S.log;
  if (!appById(L.appId)) L.appId = S.apps[0]?.id || null;
  if (!L.appId) return;
  L.files = await call('logs', L.appId);
  if (!L.files.some(f => f.path === L.path)) L.path = L.files[0]?.path || null;
  await readLog();
  render(true);
}

async function readLog() {
  const L = S.log;
  if (!L.path) { L.lines = []; L.truncated = false; return; }
  const r = await call('read_log', L.path);
  L.lines = r.lines || [];
  L.truncated = !!r.truncated;
  L.mtime = r.size;
}

async function logTick() {
  if (S.page === 'logs' && S.log.follow && S.log.path) {
    const before = S.log.mtime;
    try { await readLog(); } catch { return; }
    if (S.log.mtime !== before) renderLogBody(false);
  }
  if (S.page === 'detail') { loadActivity(); if (Date.now() % 6000 < 2000) loadMiniLog(); }
}

/* ---------------------------------------------------------- 设置页 */
const REPOS = [
  ['MAA', '明日方舟小助手', 'https://github.com/MaaAssistantArknights/MaaAssistantArknights'],
  ['M9A', '重返未来：1999 小助手', 'https://github.com/MAA1999/M9A'],
  ['MaaEnd', '明日方舟：终末地小助手', 'https://github.com/MaaEnd/MaaEnd'],
  ['MaaFramework', '以上项目共同的自动化框架', 'https://github.com/MaaXYZ/MaaFramework'],
];
function pageSettings() {
  const t = S.settings.theme || 'system';
  return `<div class="page">
    <div class="page-head"><div class="grow"><h1>设置</h1><div class="lead">外观与关于。</div></div></div>
    <div class="set-grid">
      <div class="stack">
        <div class="card card-pad">
          <div class="card-h">${icon('sun')}<h2>外观</h2></div>
          <div class="field-l">主题</div>
          <div class="seg">
            ${[['system', 'monitor', '跟随系统'], ['light', 'sun', '浅色'], ['dark', 'moon', '深色']].map(([k, ic, l]) =>
              `<button class="${t === k ? 'on' : ''}" data-act="theme" data-v="${k}">${icon(ic)}${l}</button>`).join('')}
          </div>
          <div class="hint">${icon('info')}<span>每个应用的主题色默认取自它的图标，可在应用详情页的“⋯ → 编辑信息”中修改。</span></div>
        </div>
        <div class="card card-pad">
          <div class="card-h">${icon('file')}<h2>数据</h2></div>
          <div class="field-l">应用列表与设置保存在</div>
          <div class="code">${esc(S.config)}</div>
          <div class="hint">${icon('info')}<span>移动 MaaHub.exe 时请连同这个文件一起移动。</span></div>
        </div>
      </div>
      <div class="card card-pad">
        <div class="card-h">${icon('github')}<h2>关于</h2><div class="spacer"></div><span class="faint">MaaHub v${esc(S.version)}</span></div>
        ${REPOS.map(([n, d, u]) => {
          const a = S.apps.find(x => x.name === n);
          return `<div class="link-row" data-act="url" data-v="${u}">
            ${a && a.icon ? `<img src="${a.icon}" alt="">` : `<div class="opt-ic">${icon('code')}</div>`}
            <div class="grow"><b>${n}</b><small>${d}</small></div>${icon('external')}</div>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

/* ============================================================ 弹窗 / 菜单 / 通知 */
function toast(kind, text) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = icon(kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'info') + `<div>${esc(text)}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, kind === 'error' ? 7000 : 3800);
}

function closeModal() { $('#modal-root').innerHTML = ''; }
function modal(html, onMount) {
  $('#modal-root').innerHTML = `<div class="overlay" data-act="overlay"><div class="modal">${html}</div></div>`;
  onMount && onMount($('#modal-root .modal'));
}

function confirmBox(title, text, okText = '确定', danger = false) {
  return new Promise(res => {
    modal(`<h2>${esc(title)}</h2><div class="lead" style="margin-top:8px;white-space:pre-line">${esc(text)}</div>
      <div class="modal-foot"><button class="btn" id="cf-no">取消</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" id="cf-ok">${esc(okText)}</button></div>`, m => {
      $('#cf-no', m).onclick = () => { closeModal(); res(false); };
      $('#cf-ok', m).onclick = () => { closeModal(); res(true); };
    });
  });
}

function openMenu(anchor, items) {
  const r = anchor.getBoundingClientRect();
  const root = $('#menu-root');
  root.innerHTML = `<div class="menu" style="top:${r.bottom + 6}px;right:${innerWidth - r.right}px">
    ${items.map((it, i) => it === '-' ? '<hr>' : `<button data-mi="${i}" class="${it.danger ? 'danger' : ''}">${icon(it.icon)}${it.label}</button>`).join('')}</div>`;
  $$('[data-mi]', root).forEach(b => b.onclick = e => { e.stopPropagation(); root.innerHTML = ''; items[b.dataset.mi].fn(); });
}
document.addEventListener('mousedown', e => { if (!e.target.closest('.menu')) $('#menu-root').innerHTML = ''; });

/* ---------- 添加 / 编辑应用 */
function editDialog(app) {
  const isNew = !app;
  const d = app ? { ...app } : { name: '', subtitle: '', folder: '', exe: '', kind: 'custom', color: '', admin: false, exes: [] };
  d.exes = d.exes || [];
  const kinds = S.kinds;
  const draw = () => modal(`
    <h2>${isNew ? '添加应用' : '编辑信息'}</h2>
    <div class="lead">${isNew ? '选择程序所在的文件夹，MaaHub 会自动识别类型和主程序。' : '修改名称、主程序或外观。'}</div>
    <div class="form-row"><label>程序目录</label>
      <div class="row"><input class="input" id="f-folder" value="${esc(d.folder)}" placeholder="例如 D:\\Games\\M9A">
      <button class="btn" id="f-browse">${icon('folder')}浏览</button></div></div>
    <div class="form-2">
      <div class="form-row"><label>名称</label><input class="input" id="f-name" value="${esc(d.name)}"></div>
      <div class="form-row"><label>副标题（游戏名）</label><input class="input" id="f-sub" value="${esc(d.subtitle || '')}" placeholder="可选"></div>
    </div>
    <div class="form-2">
      <div class="form-row"><label>主程序</label><select class="input" id="f-exe">
        ${[...new Set([d.exe, ...d.exes].filter(Boolean))].map(e => `<option ${e === d.exe ? 'selected' : ''}>${esc(e)}</option>`).join('') || '<option value="">（先选择目录）</option>'}
      </select></div>
      <div class="form-row"><label>类型</label><select class="input" id="f-kind">
        ${Object.entries(kinds).map(([k, v]) => `<option value="${k}" ${k === d.kind ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
      </select></div>
    </div>
    <div class="form-row"><label>主题色</label><div class="swatches">
      <button class="sw auto ${!d.color ? 'on' : ''}" data-c="" style="background:${d.auto_accent || '#666'}" title="取自图标">自动</button>
      ${PRESET_COLORS.map(c => `<button class="sw ${d.color === c ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}
      <label class="sw custom ${d.color && !PRESET_COLORS.includes(d.color) ? 'on' : ''}" title="自定义颜色" style="${d.color && !PRESET_COLORS.includes(d.color) ? `background:${d.color}` : ''}">
        <input type="color" id="f-color" value="${d.color || d.auto_accent || '#7c8cff'}"></label>
    </div></div>
    <div class="opt-row" style="border:0;padding:4px 0">
      <div class="opt-ic">${icon('shield')}</div><div class="opt-txt"><div class="opt-t">以管理员身份运行</div><div class="opt-d">部分游戏的 PC 端需要</div></div>
      <label class="switch"><input type="checkbox" id="f-admin" ${d.admin ? 'checked' : ''}><span></span></label></div>
    <div class="modal-foot"><button class="btn" id="f-cancel">取消</button><button class="btn primary" id="f-save">${icon('check')}${isNew ? '添加' : '保存'}</button></div>`,
    m => {
      const sync = () => { d.folder = $('#f-folder', m).value.trim(); d.name = $('#f-name', m).value.trim(); d.subtitle = $('#f-sub', m).value.trim();
        d.exe = $('#f-exe', m).value; d.kind = $('#f-kind', m).value; d.admin = $('#f-admin', m).checked; };
      const detect = async () => {
        sync();
        if (!d.folder) return;
        const r = await call('detect', d.folder);
        d.exes = r.exes;
        if (!r.kind) { toast('error', '这个目录里没有找到可执行文件'); draw(); return; }
        d.kind = r.kind; d.exe = r.exe;
        if (!d.name) d.name = r.name;
        if (!d.subtitle) d.subtitle = r.subtitle || '';
        draw();
      };
      $('#f-browse', m).onclick = async () => { sync(); const p = await call('pick_folder'); if (p) { $('#f-folder', m).value = p; detect(); } };
      $('#f-folder', m).onchange = detect;
      $$('.sw', m).forEach(b => b.onclick = () => { sync(); d.color = b.dataset.c; draw(); });
      $('#f-color', m).onchange = e => { sync(); d.color = e.target.value; draw(); };
      $('#f-cancel', m).onclick = closeModal;
      $('#f-save', m).onclick = async () => {
        sync();
        if (!d.folder || !d.name || !d.exe) { toast('error', '请填写程序目录、名称并选择主程序'); return; }
        const payload = { name: d.name, subtitle: d.subtitle, folder: d.folder, exe: d.exe, kind: d.kind, color: d.color, admin: d.admin };
        if (!isNew) payload.id = d.id;
        const v = await call('save_app', payload);
        closeModal();
        await reloadApps();
        toast('success', isNew ? `已添加 ${v.name}` : '已保存');
        if (isNew) go('detail', v.id); else render(true);
      };
    });
  draw();
  if (!isNew && d.folder) call('detect', d.folder).then(r => { d.exes = r.exes; draw(); });
}

async function scanDialog() {
  const root = await call('pick_folder');
  if (!root) return;
  const found = await call('scan', root);
  if (!found.length) { toast('info', '没有发现新的 MAA 系自动化程序'); return; }
  const sel = new Set(found.map((_, i) => i));
  const draw = () => modal(`<h2>发现 ${found.length} 个程序</h2><div class="lead">勾选要添加到 MaaHub 的程序。</div>
    ${found.map((f, i) => `<div class="scan-item" data-i="${i}">
      <label class="switch"><input type="checkbox" ${sel.has(i) ? 'checked' : ''}><span></span></label>
      <div><b>${esc(f.name)}</b> <span class="tag">${esc(f.kind_label)}</span><small>${esc(f.folder)}</small></div></div>`).join('')}
    <div class="modal-foot"><button class="btn" id="s-cancel">取消</button><button class="btn primary" id="s-ok">${icon('plus')}添加 ${sel.size} 个</button></div>`,
    m => {
      $$('.scan-item', m).forEach(el => el.onclick = e => { e.preventDefault(); const i = +el.dataset.i; sel.has(i) ? sel.delete(i) : sel.add(i); draw(); });
      $('#s-cancel', m).onclick = closeModal;
      $('#s-ok', m).onclick = async () => {
        await call('add_many', found.filter((_, i) => sel.has(i)));
        closeModal(); await reloadApps(); render(); toast('success', `已添加 ${sel.size} 个程序`);
      };
    });
  draw();
}

/* ============================================================ 操作 */
async function launchApp(id) {
  const a = appById(id);
  try { await api().launch(id); }
  catch (e) { toast('error', `${a.name} 启动失败：${e.message || e}`); }
}
async function stopApp(id) {
  const a = appById(id);
  const run = S.running[id];
  if (run && run.locked && !S.isAdmin) {
    if (await confirmBox(`无法直接停止 ${a.name}`,
      `${a.name} 正以管理员权限运行，而 MaaHub 是普通权限，Windows 不允许低权限程序关闭它。\n\n可以在 ${a.name} 窗口里手动退出，或者以管理员身份重启 MaaHub 后再停止。`,
      '以管理员身份重启 MaaHub')) await call('restart_as_admin');
    return;
  }
  if (await confirmBox(`停止 ${a.name}？`, '正在执行的任务会被中断。', '停止', true)) {
    await call('stop', id);
    toast('info', `正在停止 ${a.name}…`);
  }
}
async function updateField(id, field, value) {
  const v = await call('update', id, { [field]: value });
  const i = S.apps.findIndex(a => a.id === id);
  if (i >= 0) S.apps[i] = v;
  render(true);
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id, v, page } = el.dataset;
  switch (act) {
    case 'nav': go(page); break;
    case 'open': go('detail', id); break;
    case 'toggle': e.stopPropagation(); isRunning(id) ? stopApp(id) : launchApp(id); break;
    case 'launch': launchApp(id); break;
    case 'stop': stopApp(id); break;
    case 'folder': call('open_folder', id); break;
    case 'profile': updateField(id, 'profile', v); break;
    case 'open-logs': go('logs', id); break;
    case 'add': editDialog(null); break;
    case 'scan': scanDialog(); break;
    case 'seq-start': {
      const names = S.apps.filter(a => a.in_sequence).map((a, i) => `${i + 1}. ${a.name}`).join('\n');
      if (await confirmBox('开始顺序执行？', `将依次运行：\n${names}`, '开始')) await call('seq_start');
      break;
    }
    case 'seq-cancel': await call('seq_cancel'); break;
    case 'theme': setTheme(v); break;
    case 'cycle-theme': {
      const order = ['system', 'light', 'dark'];
      setTheme(order[(order.indexOf(S.settings.theme || 'system') + 1) % 3]);
      break;
    }
    case 'url': call('open_url', v); break;
    case 'log-app': S.log.appId = id; S.log.path = null; openLogPage(); break;
    case 'log-level': S.log.level = v; renderLogBody(true); break;
    case 'log-external': if (S.log.path) call('open_log_external', S.log.path); break;
    case 'overlay': if (e.target === el) closeModal(); break;
    case 'menu': {
      const a = appById(id);
      openMenu(el, [
        { icon: 'edit', label: '编辑信息', fn: () => editDialog(a) },
        { icon: 'folder', label: '打开目录', fn: () => call('open_folder', id) },
        { icon: 'terminal', label: '查看日志', fn: () => go('logs', id) },
        '-',
        { icon: 'trash', label: '从列表移除', danger: true, fn: async () => {
          if (await confirmBox(`移除 ${a.name}？`, '只会从 MaaHub 的列表中移除，不会删除程序文件。', '移除', true)) {
            await call('delete', id); await reloadApps(); go('home');
          }
        } },
      ]);
      break;
    }
  }
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.matches('input[type=checkbox][data-field]')) updateField(t.dataset.id, t.dataset.field, t.checked);
  else if (t.matches('input[data-field]')) updateField(t.dataset.id, t.dataset.field, t.value);
  else if (t.matches('[data-act-change="log-file"]')) { S.log.path = t.value; await readLog(); renderLogBody(true); }
  else if (t.id === 'log-follow') S.log.follow = t.checked;
});

let qTimer;
document.addEventListener('input', e => {
  if (e.target.id === 'log-q') {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { S.log.q = e.target.value; renderLogBody(true); }, 180);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('input[data-field]')) e.target.blur();
  if (e.key === 'Escape') { closeModal(); $('#menu-root').innerHTML = ''; }
});
