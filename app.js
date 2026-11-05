// re:Invent 2026 출장 일정 웹앱 (Firebase 버전)
// - 보기: 공용 비밀번호로 한 번 로그인하면 이 기기에 기억됩니다.
// - 데이터: Firestore 실시간 반영 + 기기 저장(오프라인이면 마지막 저장본, 오프라인 편집은 연결되면 업로드).
// - 편집: 편집 비밀번호를 넣어야 편집 모드가 켜집니다(실수 방지용).
import {
  initializeApp, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, connectAuthEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  connectFirestoreEmulator, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, serverTimestamp, getDocsFromServer,
  terminate, clearIndexedDbPersistence, enableNetwork,
} from './vendor/firebase.js';
import { firebaseConfig, VIEWER_EMAIL, viewerPassword, emulator } from './firebase-config.js';

const APP_VERSION = '2.4.0';
const COLS = ['sessions', 'places', 'meta'];
const K = { person: 'rv.person', tab: 'rv.tab', cat: 'rv.cat', lastSync: 'rv.lastSync', outbox: 'rv.outbox' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};
// 이전 버전(암호화 파일 방식)이 남긴 값 정리
['rv.key', 'rv.keyId', 'rv.enc', 'rv.fetchedAt'].forEach(store.del);

const S = {
  user: null, raw: { sessions: [], places: [], meta: [] }, ready: {}, fromCache: {}, pending: 0, model: null,
  tab: store.get(K.tab) || 'schedule', person: store.get(K.person) || '', cat: store.get(K.cat) || 'all',
  day: null, query: '', open: new Set(), edit: false, checking: false, installEvt: null,
  lastSync: store.get(K.lastSync), sheet: null,
  outbox: [], conflicts: [], flushing: false, autoDate: null,
};
let fb = null;
let unsubs = [];

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = s => esc(s).replace(/https?:\/\/[^\s<>"')]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
const pad = n => String(n).padStart(2, '0');
const safeUrl = u => /^https:\/\/\S+$/i.test(String(u || ''));

/* ---------- Firebase ---------- */
function initFirebase() {
  const app = initializeApp(firebaseConfig);
  const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  let db;
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    db = initializeFirestore(app, {});
  }
  if (emulator) {
    connectAuthEmulator(auth, `http://${emulator.host}:${emulator.authPort}`, { disableWarnings: true });
    connectFirestoreEmulator(db, emulator.host, emulator.firestorePort);
  }
  return { app, auth, db };
}

function startListeners() {
  if (unsubs.length) return;
  for (const c of COLS) {
    S.ready[c] = false; S.fromCache[c] = true;
    unsubs.push(onSnapshot(collection(fb.db, c), { includeMetadataChanges: true }, snap => {
      S.raw[c] = snap.docs.map(d => ({ ...d.data(), id: d.id, _pending: d.metadata.hasPendingWrites }));
      S.ready[c] = true;
      S.fromCache[c] = snap.metadata.fromCache;
      onData();
    }, err => {
      console.warn(c, err);
      if (err.code === 'permission-denied') toast('데이터를 볼 권한이 없어요. 비밀번호를 다시 입력해주세요.');
    }));
  }
}
function stopListeners() { unsubs.forEach(u => u()); unsubs = []; }

let frame = 0;
function onData() {
  S.pending = COLS.reduce((n, c) => n + S.raw[c].filter(d => d._pending).length, 0);
  if (COLS.every(c => S.ready[c]) && COLS.every(c => !S.fromCache[c]) && !S.pending) {
    S.lastSync = new Date().toISOString();
    store.set(K.lastSync, S.lastSync);
  }
  S.model = buildModel();
  if (S.outbox.length && !isOffline()) flushOutbox();
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!S.day && COLS.every(c => S.ready[c]) && S.model.days.length) S.day = defaultDay(); // 여행 정보까지 다 받은 뒤 정함
    renderHeader();
    if (S.tab === 'schedule' && $('schedBody')) renderScheduleBody();
    else render();
  });
}

async function checkServer() {
  if (S.checking) return;
  if (!navigator.onLine) { toast('인터넷에 연결되어 있지 않아요. 마지막 저장본을 보여드려요.'); return; }
  S.checking = true; renderHeader();
  try {
    await enableNetwork(fb.db);
    await Promise.race([
      Promise.all(COLS.map(c => getDocsFromServer(collection(fb.db, c)))),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
    ]);
    S.lastSync = new Date().toISOString(); store.set(K.lastSync, S.lastSync);
    toast(S.pending ? `최신 상태예요. 올라가길 기다리는 변경 ${S.pending}건이 있어요.` : '최신 상태예요. 고친 내용은 자동으로 바로 반영돼요.');
    flushOutbox();
  } catch {
    toast('서버에 연결하지 못했어요. 마지막 저장본을 보여드려요.');
  } finally { S.checking = false; renderHeader(); }
}

/* ---------- 데이터 정리 ---------- */
// 아직 서버에 올리지 않은 오프라인 수정(대기 목록)을 화면용 데이터에 겹칩니다.
function overlay(col) {
  const out = S.raw[col].map(d => ({ ...d }));
  for (const e of S.outbox) {
    if (e.col !== col) continue;
    const i = out.findIndex(d => d.id === e.id);
    if (i < 0) continue;
    if (e.op === 'delete') out.splice(i, 1);
    else out[i] = { ...out[i], ...e.changes, _pending: true };
  }
  return out;
}

function buildModel() {
  const metaList = overlay('meta');
  const metaDoc = metaList.find(d => d.id === 'trip');
  const settings = metaList.find(d => d.id === 'settings') || {};
  const meta = { title: 'AWS re:Invent 2026', start: '', end: '', location: '', note: '', mapUrl: '', ...(metaDoc || {}) };
  const sessions = overlay('sessions').map(d => ({ ...d, attendees: Array.isArray(d.attendees) ? d.attendees : [] }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.start || '99').localeCompare(b.start || '99') || (a.title || '').localeCompare(b.title || ''));
  const places = overlay('places');
  const hotel = places.find(x => x.h === '숙소') || null;
  let people = [];
  const widest = sessions.reduce((m, s) => (s.attendees.length > (m ? m.attendees.length : 0) ? s : m), null);
  if (widest) people = [...widest.attendees];
  for (const s of sessions) for (const a of s.attendees) if (!people.includes(a)) people.push(a);
  const dates = new Set(sessions.map(s => s.date).filter(Boolean));
  if (/^\d{4}-\d{2}-\d{2}$/.test(meta.start) && /^\d{4}-\d{2}-\d{2}$/.test(meta.end) && meta.start <= meta.end) {
    for (let d = meta.start, i = 0; d <= meta.end && i < 60; d = addDays(d, 1), i++) dates.add(d);
  }
  return { meta, settings, sessions, places, hotel, people, days: [...dates].sort() };
}

/* ---------- 날짜·시간 ---------- */
const WD = ['일', '월', '화', '수', '목', '금', '토'];
function ymd(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }; }
function addDays(s, n) { const p = ymd(s); const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
const md = s => { const p = ymd(s); return `${p.m}/${p.d}`; };
const wd = s => WD[ymd(s).wd];
const dayLabel = s => `${md(s)} (${wd(s)})`;
// '오늘'과 '지금'은 폰 시계가 아니라 일정 기준 시간대(라스베이거스)로 계산합니다.
const TRIP_TZ = 'America/Los_Angeles';
function tripNow() {
  const d = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: (S.model && S.model.meta.tz) || TRIP_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    const g = t => (parts.find(x => x.type === t) || {}).value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, min: (+g('hour') % 24) * 60 + +g('minute') };
  } catch {
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, min: d.getHours() * 60 + d.getMinutes() };
  }
}
const todayStr = () => tripNow().date;
const nowMin = () => tripNow().min;
const toMin = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
function stamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtAt(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:~(\d{2})-(\d{2}))?\s*(.*)$/.exec(at || '');
  if (!m) return at || '';
  const a = `${m[1]}-${m[2]}-${m[3]}`;
  const b = m[4] ? `${m[1]}-${m[4]}-${m[5]}` : null;
  return `${dayLabel(a)}${b ? ` ~ ${dayLabel(b)}` : ''}${m[6] ? ` · ${m[6]}` : ''}`;
}

/* ---------- 분류 ---------- */
const TYPE = {
  Keynote: ['키노트', 'sem'], Breakout: ['세션', 'sem'], Workshop: ['워크숍', 'sem'], Seminar: ['세미나', 'sem'],
  Dinner: ['저녁', 'meal'], Lunch: ['점심', 'meal'], Travel: ['이동', 'travel'], Hotel: ['숙소', 'travel'], Other: ['행사', 'other'],
};
const CATS = [
  ['megazone', '메가존 행사', '메가존 클라우드 행사', '날짜순 · 참여 문의는 메가존 담당 AM'],
  ['steak', '스테이크', '스테이크하우스'], ['seafood', '해산물', '해산물'], ['italian', '이탈리안', '이탈리안'],
  ['korean', '한식·아시안', '한식·아시안'], ['casual', '캐주얼', '캐주얼·간편식'], ['bar', '바·라운지', '바·라운지'],
  ['activity', '공연·액티비티', '공연·액티비티', '거리는 공연장 기준'], ['venue', '숙소·행사장', '숙소·행사장', '위치 참고용'],
];
const catOf = p => CATS.find(c => c[0] === p.c) || ['etc', '기타', '기타'];

function distKm(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function distText(p) {
  const H = S.model.hotel;
  if (!H || !Array.isArray(p.ll)) return '';
  if (p.id === H.id) return '숙소';
  const km = distKm(H.ll, p.ll);
  if (km == null) return '';
  return km < 1 ? `숙소에서 ${Math.round(km * 100) * 10}m` : `숙소에서 ${km.toFixed(1)}km`;
}
function placeMapUrl(p) {
  if (p.map) return p.map;
  if (p.cid) return `https://maps.google.com/?cid=${encodeURIComponent(p.cid)}`;
  if (Array.isArray(p.ll)) return `https://www.google.com/maps/search/?api=1&query=${p.ll[0]},${p.ll[1]}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.n || p.k} Las Vegas`)}`;
}
const matchText = s => `${s.title || ''} ${s.location || ''}`.toLowerCase();
const placeForSession = s => S.model.places.find(p => p.m && matchText(s).includes(String(p.m).toLowerCase()));
const sessionsForPlace = p => p.m ? S.model.sessions.filter(s => matchText(s).includes(String(p.m).toLowerCase())) : [];

/* ---------- 화면 전환 ---------- */
function showLock(msg) {
  $('app').hidden = true;
  $('lock').hidden = false;
  closeSheet();
  const m = $('lockMsg');
  if (!fb) { m.textContent = '앱 설정이 아직 끝나지 않았어요.'; m.className = 'lock-msg ok'; $('unlockBtn').disabled = true; }
  else { m.textContent = msg || ''; m.className = 'lock-msg'; $('unlockBtn').disabled = false; }
  $('lockInstall').innerHTML = installHtml();
}
function showApp() {
  $('lock').hidden = true;
  $('app').hidden = false;
  render();
}
// 오늘(라스베이거스 날짜)이 일정 기간 안이면 오늘, 시작 전이면 첫날, 끝난 뒤면 마지막 날
function defaultDay() {
  const days = S.model.days, t = todayStr();
  S.autoDate = t;
  if (days.includes(t)) return t;
  if (days.length && t > days[days.length - 1]) return days[days.length - 1];
  return days[0] || t;
}

function render() {
  renderHeader();
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
  const fab = $('fab');
  fab.hidden = !(S.edit && S.model && (S.tab === 'schedule' || S.tab === 'places'));
  fab.textContent = S.tab === 'places' ? '+ 장소 추가' : '+ 일정 추가';
  $('editBar').hidden = !S.edit;
  document.body.classList.toggle('editing', S.edit);
  if (!S.model || !COLS.every(c => S.ready[c])) { $('view').innerHTML = '<p class="empty">일정을 불러오는 중…</p>'; return; }
  if (!S.raw.sessions.length && !S.raw.places.length) {
    $('view').innerHTML = `<p class="empty">아직 등록된 일정이 없어요.${S.edit ? '' : '<br>위쪽 <b>편집</b>을 눌러 추가할 수 있어요.'}</p>`;
    if (S.tab === 'info') renderInfo();
    return;
  }
  if (S.tab === 'places') renderPlaces();
  else if (S.tab === 'info') renderInfo();
  else renderSchedule();
}

function renderHeader() {
  const meta = S.model ? S.model.meta : { title: 're:Invent 2026' };
  $('tTitle').textContent = meta.title || 're:Invent 2026';
  $('tSub').textContent = [meta.location, meta.start && meta.end ? `${md(meta.start)}–${md(meta.end)}` : ''].filter(Boolean).join(' · ');
  const pill = $('syncPill');
  const allReady = COLS.every(c => S.ready[c]);
  const cached = COLS.some(c => S.fromCache[c]);
  let text, warn = false;
  const waiting = S.pending + S.outbox.length;
  if (S.checking) text = '확인 중';
  else if (S.conflicts.length) { text = `확인 필요 ${S.conflicts.length}건`; warn = true; }
  else if (!navigator.onLine) { text = waiting ? `오프라인 · 대기 ${waiting}건` : `오프라인 ${stamp(S.lastSync)}`.trim(); warn = true; }
  else if (waiting) { text = `대기 ${waiting}건`; warn = true; }
  else if (!allReady || cached) { text = '연결 중'; warn = true; }
  else text = '실시간';
  $('syncText').textContent = text;
  pill.classList.toggle('busy', S.checking);
  pill.classList.toggle('offline', warn);
  const eb = $('editBtn');
  eb.classList.toggle('on', S.edit);
  $('editText').textContent = S.edit ? '완료' : '편집';
}

/* ---------- 일정 ---------- */
const ICON_SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_MAP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.2" fill="currentColor"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const forPerson = s => !S.person || !s.attendees.length || s.attendees.includes(S.person);
const matchesQuery = (s, q) => [s.title, s.location, s.note, s.people, s.type, s.track].some(v => String(v || '').toLowerCase().includes(q));

function renderSchedule() {
  const { people } = S.model;
  if (S.person && !people.includes(S.person)) S.person = '';
  $('view').innerHTML = `
    <div class="search">${ICON_SEARCH}<input id="q" type="search" placeholder="세션·장소·메모 검색" value="${esc(S.query)}" enterkeyhint="search"></div>
    <div class="chips" role="group" aria-label="출장자">
      <button class="chip ${S.person ? '' : 'active'}" data-act="person" data-v="">전체</button>
      ${people.map(n => `<button class="chip ${S.person === n ? 'active' : ''}" data-act="person" data-v="${esc(n)}">${esc(n)}</button>`).join('')}
    </div>
    <div id="schedBody"></div>`;
  renderScheduleBody();
}

function renderScheduleBody() {
  const box = $('schedBody');
  if (!box || !S.model) return;
  const q = S.query.trim().toLowerCase();
  const list = S.model.sessions.filter(forPerson);
  if (q) {
    const hits = list.filter(s => matchesQuery(s, q));
    const byDay = new Map();
    for (const s of hits) { if (!byDay.has(s.date)) byDay.set(s.date, []); byDay.get(s.date).push(s); }
    box.innerHTML = hits.length
      ? `<p class="hint">검색 결과 ${hits.length}건</p>${[...byDay].map(([d, arr]) => `<h4 class="group-h">${esc(d ? dayLabel(d) : '날짜 없음')}</h4><ol class="cards">${arr.map(s => sessionCard(s, d)).join('')}</ol>`).join('')}`
      : `<p class="empty">'${esc(S.query)}'에 맞는 일정이 없어요.</p>`;
    return;
  }
  const t = todayStr();
  const days = S.model.days.map(d => {
    const n = list.filter(s => s.date === d).length;
    return `<button class="day ${d === S.day ? 'active' : ''} ${d === t ? 'today' : ''} ${n ? '' : 'none'}" data-act="day" data-v="${d}" aria-pressed="${d === S.day}">
      <b>${md(d)}</b><span>${d === t ? '오늘' : wd(d)} · ${n}</span></button>`;
  }).join('');
  const items = list.filter(s => s.date === S.day);
  box.innerHTML = `
    <div class="days" id="days">${days}</div>
    <p class="hint">시간과 '오늘'은 모두 라스베이거스 현지 기준이에요. 카드를 누르면 자세한 내용이 보여요.</p>
    ${items.length ? `<ol class="cards">${items.map(s => sessionCard(s, S.day)).join('')}</ol>` : '<p class="empty">이 날은 등록된 일정이 없어요.</p>'}`;
  const active = box.querySelector('.day.active');
  if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function sessionState(s, d) {
  if (d !== todayStr()) return '';
  const a = toMin(s.start), b = toMin(s.end), n = nowMin();
  if (a == null) return '';
  if (b != null && a <= n && n < b) return 'now';
  if (b != null && n >= b) return 'past';
  if (b == null && n >= a + 60) return 'past';
  return '';
}

function sessionCard(s, d) {
  const [label, cls] = TYPE[s.type] || [s.type || '일정', 'other'];
  const st = sessionState(s, d);
  const list = S.model.sessions.filter(x => x.date === d && forPerson(x));
  const upcoming = d === todayStr() ? list.find(x => toMin(x.start) != null && toMin(x.start) > nowMin()) : null;
  const isNext = upcoming && upcoming.id === s.id && !st;
  const open = S.open.has(s.id);
  const all = S.model.people.length && s.attendees.length === S.model.people.length;
  const who = s.attendees.length && !all ? s.attendees.join(' · ') : '';
  return `<li class="card s-card ${st} ${open ? 'open' : ''}">
    <button class="card-main" data-act="toggle" data-v="${esc(s.id)}" aria-expanded="${open}">
      <div class="time"><b>${esc(s.start || '—')}</b>${s.end ? `<span>${esc(s.end)}</span>` : ''}</div>
      <div class="body">
        <div class="badges"><span class="badge ${cls}">${esc(label)}</span>${s.track === 'Security' ? '<span class="badge sec">Security</span>' : ''}${st === 'now' ? '<span class="badge now">진행 중</span>' : ''}${isNext ? '<span class="badge next">다음</span>' : ''}${s._pending ? '<span class="badge memo">저장 대기</span>' : ''}</div>
        <h3>${esc(s.title || '(제목 없음)')}</h3>
        ${s.location ? `<p class="loc">${esc(s.location)}</p>` : ''}
        ${who ? `<p class="who">${esc(who)}</p>` : ''}
      </div>
      ${ICON_CHEV}
    </button>
    ${open ? sessionDetail(s) : ''}
  </li>`;
}

function sessionDetail(s) {
  const p = placeForSession(s);
  const mapUrl = p ? placeMapUrl(p) : s.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.location} Las Vegas`)}` : '';
  const travel = s.type === 'Travel';
  return `<div class="detail">
    ${s.people ? `<p class="kv"><b>${TYPE[s.type] && TYPE[s.type][1] === 'sem' ? '연사' : '참고'}</b> · ${esc(s.people)}</p>` : ''}
    ${s.attendees.length ? `<p class="kv"><b>출장자</b> · ${esc(s.attendees.join(' · '))}</p>` : ''}
    ${s.note ? `<div class="note">${linkify(s.note)}</div>` : ''}
    <div class="actions">
      ${mapUrl && !travel ? `<a class="btn" href="${esc(mapUrl)}" target="_blank" rel="noopener">${ICON_MAP}${p ? esc(p.k || p.n) : '지도에서 보기'}</a>` : ''}
      ${p ? `<button class="btn" type="button" data-act="goPlace" data-v="${esc(p.id)}">장소 안내 보기</button>` : ''}
    </div>
    ${S.edit ? `<div class="actions edit-actions"><button class="btn primary" type="button" data-act="editSession" data-v="${esc(s.id)}">수정</button><button class="btn danger" type="button" data-act="delSession" data-v="${esc(s.id)}">삭제</button></div>` : ''}
  </div>`;
}

/* ---------- 장소 ---------- */
function renderPlaces() {
  const { places, hotel } = S.model;
  const counts = new Map();
  for (const p of places) { const k = catOf(p)[0]; counts.set(k, (counts.get(k) || 0) + 1); }
  const cats = [...CATS, ['etc', '기타', '기타']].filter(c => counts.get(c[0]));
  if (S.cat !== 'all' && !counts.get(S.cat)) S.cat = 'all';
  const shown = cats.filter(c => S.cat === 'all' || c[0] === S.cat);
  const sortIn = (k, arr) => k === 'megazone'
    ? arr.sort((a, b) => (a.at || '').localeCompare(b.at || ''))
    : arr.sort((a, b) => (distKm(hotel?.ll, a.ll) ?? 1e9) - (distKm(hotel?.ll, b.ll) ?? 1e9));
  $('view').innerHTML = `
    <div class="chips" role="group" aria-label="종류">
      <button class="chip ${S.cat === 'all' ? 'active' : ''}" data-act="cat" data-v="all">전체<small>${places.length}</small></button>
      ${cats.map(c => `<button class="chip ${S.cat === c[0] ? 'active' : ''}" data-act="cat" data-v="${c[0]}">${esc(c[1])}<small>${counts.get(c[0])}</small></button>`).join('')}
    </div>
    ${safeUrl(S.model.meta.mapUrl) ? `<div class="actions map-row"><a class="btn primary" href="${esc(S.model.meta.mapUrl)}" target="_blank" rel="noopener">${ICON_MAP}구글 공유맵 열기</a></div>` : ''}
    ${hotel ? `<p class="hint">거리는 숙소(${esc(hotel.k || hotel.n)})에서 잰 직선거리예요. 영업시간·예약은 방문 전에 공식 사이트에서 확인하세요.</p>` : ''}
    ${shown.map(c => `
      <h3 class="section-title">${esc(c[2])}${c[3] ? `<small>${esc(c[3])}</small>` : ''}</h3>
      <ol class="cards">${sortIn(c[0], places.filter(p => catOf(p)[0] === c[0])).map(placeCard).join('')}</ol>`).join('')}`;
}

function placeCard(p) {
  const open = S.open.has('p:' + p.id);
  const mz = p.c === 'megazone';
  const dist = distText(p);
  const linked = sessionsForPlace(p);
  return `<li class="card p-card ${open ? 'open' : ''}" id="place-${esc(p.id)}">
    <button class="card-main" data-act="toggle" data-v="p:${esc(p.id)}" aria-expanded="${open}">
      <div class="body">
        <div class="badges">
          ${p.h ? `<span class="badge home">${esc(p.h)}</span>` : ''}
          ${p.pr ? `<span class="badge">${esc(p.pr)}</span>` : ''}
          ${p.memo ? `<span class="badge memo">${esc(p.memo)}</span>` : ''}
          ${linked.length ? `<span class="badge sem">일정 ${linked.map(s => md(s.date)).filter((v, i, a) => a.indexOf(v) === i).join('·')}</span>` : ''}
          ${p._pending ? '<span class="badge memo">저장 대기</span>' : ''}
        </div>
        <h3>${esc(p.k || p.n)}${p.k && p.n && p.k !== p.n ? `<small>${esc(p.n)}</small>` : ''}</h3>
        ${mz && p.at ? `<p class="when">${esc(fmtAt(p.at))}</p>` : ''}
        <p class="sub">${esc([p.t, p.v].filter(Boolean).join(' · '))}</p>
        ${dist ? `<p class="dist">${esc(dist)}</p>` : ''}
      </div>
      ${ICON_CHEV}
    </button>
    ${open ? `<div class="detail">
      ${p.d ? `<p>${esc(p.d)}</p>` : ''}
      ${p.x ? `<div class="tip">${linkify(p.x)}</div>` : ''}
      ${linked.length ? `<p class="kv"><b>연결된 일정</b> · ${linked.map(s => `${esc(dayLabel(s.date))} ${esc(s.start || '')} ${esc(s.title)}`).join('<br>')}</p>` : ''}
      <div class="actions">
        <a class="btn primary" href="${esc(placeMapUrl(p))}" target="_blank" rel="noopener">${ICON_MAP}지도</a>
        ${p.w ? `<a class="btn" href="${esc(p.w)}" target="_blank" rel="noopener">${ICON_LINK}웹사이트</a>` : ''}
      </div>
      ${S.edit ? `<div class="actions edit-actions"><button class="btn primary" type="button" data-act="editPlace" data-v="${esc(p.id)}">수정</button><button class="btn danger" type="button" data-act="delPlace" data-v="${esc(p.id)}">삭제</button></div>` : ''}
    </div>` : ''}
  </li>`;
}

/* ---------- 정보 ---------- */
const UA = navigator.userAgent;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const appUrl = () => location.origin + location.pathname;

// 지금 브라우저에서 홈 화면에 추가하는 방법의 종류
function installKind() {
  if (isStandalone()) return 'installed';
  if (/KAKAOTALK|NAVER\(inapp|Line\/|Instagram|FBAN|FBAV|DaumApps/i.test(UA)) return 'inapp';
  if (S.installEvt) return 'prompt';
  if (isIOS()) return /CriOS/.test(UA) ? 'ios-chrome' : /FxiOS|EdgiOS/.test(UA) ? 'ios-other' : 'ios-safari';
  if (/SamsungBrowser/.test(UA)) return 'samsung';
  if (/Android/.test(UA)) return 'android';
  return 'desktop';
}

const SHARE = '<b>공유 버튼</b>(네모에 위쪽 화살표)';
const INSTALL_STEPS = {
  'ios-safari': [`화면 아래쪽 ${SHARE}을 누르세요. 안 보이면 주소창 옆 <b>⋯</b>을 먼저 누르세요.`, '목록을 내려 <b>홈 화면에 추가</b>를 누르세요.', '오른쪽 위 <b>추가</b>를 누르세요.'],
  'ios-chrome': [`주소창 오른쪽의 ${SHARE}을 누르세요. 안 보이면 <b>⋯</b> 메뉴에서 <b>공유</b>를 누르세요.`, '목록을 내려 <b>홈 화면에 추가</b>를 누르세요.', '오른쪽 위 <b>추가</b>를 누르세요.'],
  'ios-other': [`브라우저의 ${SHARE}을 누르세요.`, '<b>홈 화면에 추가</b>를 누르세요. 목록에 없으면 이 주소를 Safari로 열어주세요.'],
  android: ['오른쪽 위 <b>⋮</b> 메뉴를 누르세요.', '<b>홈 화면에 추가</b> 또는 <b>앱 설치</b>를 누르세요.', '<b>설치</b>를 누르세요.'],
  samsung: ['아래쪽 <b>≡</b> 메뉴를 누르세요.', '<b>현재 페이지 추가</b> → <b>홈 화면</b>을 누르세요.'],
  desktop: ['주소창 오른쪽의 <b>설치</b> 아이콘을 누르세요.', '안 보이면 <b>⋮</b> 메뉴에서 <b>앱 설치</b> 또는 <b>홈 화면에 추가</b>를 누르세요.'],
};

function guideHtml(kind) {
  if (kind === 'inapp') {
    const kakao = /KAKAOTALK/i.test(UA);
    return `<p class="sheet-note">메신저 안에서 열린 화면에서는 홈 화면에 추가할 수 없어요. <b>${isIOS() ? 'Safari' : 'Chrome'}</b>${isIOS() ? '로' : '으로'} 다시 열어주세요.</p>
      <ol class="steps">${kakao
        ? `<li>${isIOS() ? '오른쪽 아래' : '오른쪽 위'} <b>⋯</b> 메뉴를 누르세요.</li><li><b>${isIOS() ? 'Safari로 열기' : '다른 브라우저로 열기'}</b>를 누르세요.</li>`
        : '<li>메뉴에서 <b>브라우저로 열기</b>를 누르세요.</li><li>메뉴가 없으면 아래 주소를 복사해서 브라우저에 붙여넣으세요.</li>'}
        <li>열린 브라우저에서 다시 <b>정보 → 홈 화면에 추가하기</b>를 누르세요.</li></ol>
      <p class="url-box">${esc(appUrl())}</p>
      <div class="actions">${kakao ? `<a class="btn primary" href="kakaotalk://web/openExternal?url=${encodeURIComponent(appUrl())}">다른 브라우저로 열기</a>` : ''}<button class="btn" type="button" data-act="copyLink">주소 복사</button></div>`;
  }
  const steps = INSTALL_STEPS[kind] || INSTALL_STEPS.android;
  return `<ol class="steps">${steps.map(t => `<li>${t}</li>`).join('')}<li>홈 화면에 생긴 <b>re:Invent</b> 아이콘으로 여세요.</li></ol>
    ${isIOS() ? '<p class="sheet-note">아이콘으로 처음 열 때 보기 비밀번호를 한 번 더 넣어주세요. 인터넷이 될 때 한 번 열어둬야 오프라인에서도 열려요.</p>' : ''}`;
}

// 잠금 화면에 바로 보여주는 안내
function installHtml() {
  const kind = installKind();
  if (kind === 'installed') return '';
  if (kind === 'prompt') return '<div class="install"><h3>홈 화면에 앱으로 추가</h3><div class="actions"><button class="btn green" type="button" data-act="install">홈 화면에 추가하기</button></div></div>';
  return `<div class="install"><h3>${kind === 'inapp' ? '브라우저에서 열어주세요' : '홈 화면에 앱으로 추가'}</h3>${guideHtml(kind)}</div>`;
}

// 정보 탭 버튼 영역
function installPanel() {
  if (installKind() === 'installed') return '<div class="panel"><h3>홈 화면 앱</h3><p class="muted">지금 홈 화면 앱으로 열려 있어요. 인터넷이 없어도 마지막 저장본이 보여요.</p></div>';
  return `<div class="panel"><h3>홈 화면에 추가</h3><p class="muted">아이콘을 누르면 앱처럼 전체 화면으로 열리고, 인터넷이 없어도 일정이 보여요.</p>
    <div class="actions"><button class="btn green" type="button" data-act="install">홈 화면에 추가하기</button></div></div>`;
}

async function doInstall() {
  const kind = installKind();
  if (kind === 'prompt' && S.installEvt) {
    const evt = S.installEvt;
    S.installEvt = null;
    try {
      await evt.prompt();
      const r = await evt.userChoice;
      if (r && r.outcome === 'accepted') toast('홈 화면에 추가했어요.');
    } catch { openSheet({ title: '홈 화면에 추가하기', html: guideHtml(isIOS() ? 'ios-safari' : 'android'), submit: '알겠어요', noCancel: true, onSubmit: closeSheet }); }
    refreshInstallUi();
    return;
  }
  openSheet({ title: kind === 'inapp' ? '브라우저에서 열어주세요' : '홈 화면에 추가하기', html: guideHtml(kind), submit: '알겠어요', noCancel: true, onSubmit: closeSheet });
}

function refreshInstallUi() {
  if (!$('lock').hidden) $('lockInstall').innerHTML = installHtml();
  if (S.tab === 'info' && S.model && !$('app').hidden) renderInfo();
}

function renderInfo() {
  const { meta, people, sessions, places } = S.model;
  $('view').innerHTML = `
    <div class="hero">
      <small>EXECUTIVE TRIP PLANNER</small>
      <h2>${esc(meta.title)}</h2>
      ${meta.note ? `<p>${esc(meta.note)}</p>` : ''}
      <div class="pills">
        ${meta.start && meta.end ? `<span>${esc(dayLabel(meta.start))} ~ ${esc(dayLabel(meta.end))}</span>` : ''}
        ${meta.location ? `<span>${esc(meta.location)}</span>` : ''}
        ${safeUrl(meta.mapUrl) ? `<a class="map-pill" href="${esc(meta.mapUrl)}" target="_blank" rel="noopener">구글 공유맵 ↗</a>` : ''}
      </div>
      ${S.edit ? '<div class="actions"><button class="btn primary" type="button" data-act="editTrip">여행 정보 수정</button></div>' : ''}
    </div>
    ${installPanel()}
    <div class="panel">
      <h3>출장자</h3>
      <p>${people.map(esc).join(' · ') || '—'}</p>
      <p class="muted">일정 ${sessions.length}건 · 맛집·장소 ${places.length}건 · 출장자 목록은 일정의 참석자에서 자동으로 모아요.</p>
    </div>
    <div class="panel">
      <h3>동기화</h3>
      <dl class="rows">
        <dt>상태</dt><dd>${esc({ '실시간': '실시간 연결됨' }[$('syncText').textContent] || $('syncText').textContent)}</dd>
        <dt>마지막으로 서버와 맞춘 시각</dt><dd>${esc(stamp(S.lastSync) || '—')}</dd>
      </dl>
      <p class="muted">누군가 고치면 몇 초 안에 모두의 화면에 반영돼요. 저장할 때는 바꾼 칸만 올라가서, 다른 사람이 다른 칸을 고친 건 지워지지 않아요.</p>
      <p class="muted">인터넷이 끊기면 마지막 저장본을 보여줘요. 그동안 고친 내용은 이 기기에 보관했다가, 연결되면 다른 사람 수정과 비교해서 올려요. 같은 칸을 다른 사람이 먼저 고쳤으면 어느 쪽으로 할지 물어봐요.</p>
      ${S.outbox.length ? `<p class="muted"><b>올라가길 기다리는 오프라인 수정 ${S.outbox.length}건</b></p>` : ''}
      <div class="actions"><button class="btn green" type="button" data-act="check" ${S.checking ? 'disabled' : ''}>지금 확인</button></div>
    </div>
    <div class="panel">
      <h3>편집</h3>
      <p class="muted">위쪽 <b>편집</b> 버튼을 누르고 편집 비밀번호를 넣으면 일정과 장소를 추가·수정·삭제할 수 있어요. ${S.model.settings.editHash ? '' : '아직 편집 비밀번호가 없어서, 처음 편집할 때 정하게 돼요.'}</p>
      ${S.edit ? '<div class="actions"><button class="btn" type="button" data-act="setEditPw">편집 비밀번호 바꾸기</button></div>' : ''}
    </div>
    <div class="panel">
      <h3>이 기기</h3>
      <p class="muted">로그인 정보와 이 기기에 저장된 일정을 지웁니다. 다시 열면 비밀번호를 물어요.</p>
      <div class="actions"><button class="btn danger" type="button" data-act="forget">이 기기에서 지우기</button></div>
    </div>
    <p class="foot">버전 ${APP_VERSION} · 행사 시간과 영업시간은 공식 안내를 확인하세요.</p>`;
}

/* ---------- 편집 ---------- */
async function sha256hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function randHex(n) { return [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, '0')).join(''); }

function toggleEdit() {
  if (S.edit) { S.edit = false; render(); toast('편집을 마쳤어요.'); return; }
  if (!S.model || !S.ready.meta) { toast('설정을 불러오는 중이에요. 잠시 후 다시 눌러주세요.'); return; }
  if (S.model.settings.editHash) openEditPwSheet(); else openSetEditPwSheet(true);
}

function field(f) {
  const id = `f_${f.name}`;
  const v = f.value ?? '';
  const help = f.help ? `<small>${esc(f.help)}</small>` : '';
  let input;
  if (f.type === 'textarea') input = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 4}" placeholder="${esc(f.ph || '')}">${esc(v)}</textarea>`;
  else if (f.type === 'select') input = `<select id="${id}" name="${f.name}">${f.options.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`;
  else if (f.type === 'people') {
    const sel = new Set(v || []);
    input = `<div class="checks">${f.options.map(n => `<label class="check"><input type="checkbox" name="${f.name}" value="${esc(n)}" ${sel.has(n) ? 'checked' : ''}><span>${esc(n)}</span></label>`).join('')}</div>
      <input id="${id}_extra" name="${f.name}_extra" type="text" placeholder="다른 사람 추가 (쉼표로 구분)">`;
  } else input = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.ph || '')}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''}>`;
  return `<div class="fg ${f.half ? 'half' : ''}"><label for="${id}">${esc(f.label)}${f.required ? ' <em>*</em>' : ''}</label>${input}${help}</div>`;
}

function openSheet({ title, fields = [], html = '', submit, danger, dangerPlain, onSubmit, onDanger, note, noCancel }) {
  S.sheet = { onSubmit, onDanger };
  $('sheetTitle').textContent = title;
  $('sheetForm').innerHTML = `${note ? `<p class="sheet-note">${note}</p>` : ''}${html}${fields.length ? `<div class="fields">${fields.map(field).join('')}</div>` : ''}
    <p class="form-err" id="formErr" role="alert"></p>
    <div class="sheet-actions">${danger ? `<button type="button" class="btn ${dangerPlain ? '' : 'danger'}" data-act="sheetDanger">${esc(danger)}</button>` : ''}<span class="spacer"></span>
      ${noCancel ? '' : '<button type="button" class="btn" data-act="closeSheet">취소</button>'}<button type="submit" class="btn primary">${esc(submit)}</button></div>`;
  $('sheet').hidden = false;
  document.body.classList.add('noscroll');
  const first = $('sheetForm').querySelector('input:not([type=checkbox]),textarea,select');
  if (first && fields.length <= 2) setTimeout(() => first.focus(), 50);
}
function closeSheet() {
  $('sheet').hidden = true;
  document.body.classList.remove('noscroll');
  S.sheet = null;
}
const formErr = msg => { $('formErr').textContent = msg; };
function formValues() {
  const fd = new FormData($('sheetForm'));
  const out = {};
  for (const [k, v] of fd.entries()) {
    if (k in out) out[k] = [].concat(out[k], v); else out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

function openEditPwSheet() {
  openSheet({
    title: '편집 비밀번호', submit: '편집 시작',
    note: '실수로 고치는 걸 막기 위한 비밀번호예요.',
    fields: [{ name: 'pw', label: '편집 비밀번호', type: 'password', autocomplete: 'off' }],
    onSubmit: async v => {
      const st = S.model.settings;
      if ((await sha256hex(`${st.editSalt}:${v.pw}`)) !== st.editHash) { formErr('편집 비밀번호가 맞지 않아요.'); return; }
      closeSheet(); S.edit = true; render();
      toast('편집 모드예요. 카드를 펼치면 수정·삭제 버튼이 보여요.');
    },
  });
}
function openSetEditPwSheet(first) {
  openSheet({
    title: first ? '편집 비밀번호 정하기' : '편집 비밀번호 바꾸기', submit: '저장',
    note: first ? '아직 편집 비밀번호가 없어요. 함께 편집할 분들과 나눌 비밀번호를 정해주세요.' : '새 편집 비밀번호를 넣어주세요. 함께 편집하는 분들께도 알려주세요.',
    fields: [{ name: 'pw', label: '새 편집 비밀번호 (4자 이상)', type: 'password', autocomplete: 'new-password' }, { name: 'pw2', label: '한 번 더', type: 'password', autocomplete: 'new-password' }],
    onSubmit: async v => {
      if ((v.pw || '').length < 4) { formErr('4자 이상으로 정해주세요.'); return; }
      if (v.pw !== v.pw2) { formErr('두 칸이 서로 달라요.'); return; }
      const salt = randHex(16);
      setDirect('meta', 'settings', { editSalt: salt, editHash: await sha256hex(`${salt}:${v.pw}`) }, '편집 비밀번호를 저장했어요.');
      S.edit = true; render();
    },
  });
}

/* ---------- 저장: 바꾼 칸만 · 오프라인 대기 목록 · 충돌 확인 ---------- */
const FIELD_LABEL = {
  title: '제목', date: '날짜', start: '시작', end: '끝', type: '종류', track: '트랙', location: '장소', attendees: '출장자', people: '연사·참고', note: '메모',
  k: '이름(한글)', n: '이름(영문)', c: '분류', pr: '가격대', at: '행사 일시', t: '종류 설명', v: '위치', h: '숙소 표시', memo: '메모 배지',
  d: '소개', x: '방문 팁', w: '공식 사이트', map: '지도 링크', ll: '좌표', m: '일정 연결 단어', mapUrl: '구글 공유맵 링크', cid: '지도 ID',
};
const blank = v => v == null || v === '' || (Array.isArray(v) && !v.length);
const same = (a, b) => (blank(a) && blank(b)) || JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every(x => b.includes(x));
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
const fieldsOf = d => Object.fromEntries(Object.entries(d || {}).filter(([k]) => !['id', '_pending', 'updatedAt'].includes(k)));
const diffFields = (a, b) => [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(k => !same((a || {})[k], (b || {})[k]));
const rawDoc = (col, id) => S.raw[col].find(d => d.id === id) || null;
// 서버와 실시간으로 연결돼 있지 않으면 오프라인으로 봅니다.
const isOffline = () => !navigator.onLine || !COLS.every(c => S.ready[c] && !S.fromCache[c]);
const warnErr = err => toast(err && err.code === 'not-found' ? '다른 사람이 삭제한 항목이라 저장하지 못했어요.' : `저장하지 못했어요 (${(err && (err.code || err.message)) || '알 수 없음'})`);

function loadOutbox() { try { const v = JSON.parse(store.get(K.outbox) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function saveOutbox() { if (S.outbox.length) store.set(K.outbox, JSON.stringify(S.outbox)); else store.del(K.outbox); }
function dropEntry(e) { S.outbox = S.outbox.filter(x => x !== e); }
function refreshModel() { if (S.model) { S.model = buildModel(); render(); } }

// 새 항목·설정: 겹칠 일이 없으므로 Firebase가 바로 저장합니다(오프라인이면 Firebase가 보관했다가 올림).
function setDirect(col, id, data, okMsg) {
  const p = setDoc(doc(fb.db, col, id), { ...data, updatedAt: serverTimestamp() }, { merge: true });
  closeSheet();
  if (okMsg) toast(isOffline() ? `${okMsg} 인터넷이 연결되면 올라가요.` : okMsg);
  p.catch(warnErr);
}

// 기존 항목 수정: 바꾼 칸만 저장합니다. 오프라인이면 대기 목록에 넣습니다.
function commitChanges(col, id, changes) {
  if (!Object.keys(changes).length) return 'none';
  if (isOffline() || S.outbox.some(e => e.col === col && e.id === id)) {
    queueUpdate(col, id, changes);
    if (!isOffline()) flushOutbox();
    return 'queued';
  }
  updateDoc(doc(fb.db, col, id), { ...changes, updatedAt: serverTimestamp() }).catch(warnErr);
  return 'sent';
}
function saveEdit(col, id, next, orig, okMsg) {
  const changes = {};
  for (const [f, v] of Object.entries(next)) if (!same(v, orig[f])) changes[f] = v;
  closeSheet();
  const r = commitChanges(col, id, changes);
  if (r === 'none') toast('바뀐 내용이 없어요.');
  else toast(r === 'queued' ? `${okMsg} 인터넷이 연결되면 다른 사람 수정과 비교해서 올려요.` : okMsg);
  refreshModel();
}
function queueUpdate(col, id, changes) {
  const server = rawDoc(col, id);
  let e = S.outbox.find(x => x.col === col && x.id === id);
  if (e && e.op === 'delete') return;
  if (!e) { e = { col, id, op: 'update', changes: {}, base: {}, snapshot: fieldsOf(server), at: Date.now() }; S.outbox.push(e); }
  for (const [f, v] of Object.entries(changes)) {
    if (!(f in e.base)) e.base[f] = server && server[f] !== undefined ? server[f] : null;
    e.changes[f] = v;
    if (same(e.changes[f], e.base[f])) { delete e.changes[f]; delete e.base[f]; }
  }
  if (!Object.keys(e.changes).length) dropEntry(e);
  saveOutbox();
}

function removeDoc(col, id, okMsg) {
  closeSheet();
  const local = rawDoc(col, id);
  const prev = S.outbox.find(x => x.col === col && x.id === id);
  if (isOffline() && local && !local._pending) {
    const snapshot = prev ? prev.snapshot : fieldsOf(local);
    if (prev) dropEntry(prev);
    S.outbox.push({ col, id, op: 'delete', snapshot, at: Date.now() });
    saveOutbox();
    toast(`${okMsg} 인터넷이 연결되면 다른 사람 수정과 비교해서 반영해요.`);
  } else {
    if (prev) { dropEntry(prev); saveOutbox(); }
    deleteDoc(doc(fb.db, col, id)).catch(warnErr);
    toast(okMsg);
  }
  refreshModel();
}

// 다시 연결되면 대기 목록을 서버 최신 내용과 비교해서 올립니다.
function flushOutbox() {
  if (S.flushing || S.conflicts.length || !S.outbox.length || isOffline()) return;
  S.flushing = true;
  let applied = 0;
  const conflicts = [];
  for (const e of [...S.outbox]) {
    const cur = rawDoc(e.col, e.id);
    const ref = doc(fb.db, e.col, e.id);
    if (e.op === 'delete') {
      if (!cur) { dropEntry(e); continue; }
      const changed = diffFields(e.snapshot, fieldsOf(cur));
      if (!changed.length) { deleteDoc(ref).catch(warnErr); dropEntry(e); applied++; } else conflicts.push({ e, kind: 'edited', fields: changed });
      continue;
    }
    if (!cur) { conflicts.push({ e, kind: 'deleted' }); continue; }
    const keys = Object.keys(e.changes);
    const clash = keys.filter(f => !same(cur[f], e.base[f]) && !same(cur[f], e.changes[f]));
    const ok = keys.filter(f => !clash.includes(f));
    if (ok.length) { updateDoc(ref, { ...pick(e.changes, ok), updatedAt: serverTimestamp() }).catch(warnErr); applied++; }
    if (clash.length) { e.changes = pick(e.changes, clash); e.base = pick(e.base, clash); conflicts.push({ e, kind: 'clash', fields: clash }); } else dropEntry(e);
  }
  saveOutbox();
  S.conflicts = conflicts;
  S.flushing = false;
  if (applied || conflicts.length) refreshModel();
  if (applied) toast(`오프라인에서 고친 ${applied}건을 올렸어요.${conflicts.length ? ` 확인이 필요한 ${conflicts.length}건이 있어요.` : ''}`);
  if (conflicts.length) setTimeout(showConflict, applied ? 900 : 0);
}

function docName(e) {
  const d = e.snapshot || {};
  if (e.col === 'meta') return '여행 정보';
  return d.title || d.k || d.n || (e.changes && (e.changes.title || e.changes.k || e.changes.n)) || e.id;
}
function fmtVal(f, v) {
  if (blank(v)) return '<i>(비어 있음)</i>';
  const t = Array.isArray(v) ? v.join(f === 'll' ? ', ' : ' · ') : String(v);
  return esc(t.length > 120 ? `${t.slice(0, 120)}…` : t);
}
function diffTable(fields, left, right, leftLabel, rightLabel) {
  return `<table class="diff"><thead><tr><th></th><th>${leftLabel}</th><th>${rightLabel}</th></tr></thead><tbody>${fields.map(f => `<tr><th>${esc(FIELD_LABEL[f] || f)}</th><td>${fmtVal(f, left[f])}</td><td>${fmtVal(f, right[f])}</td></tr>`).join('')}</tbody></table>`;
}

function showConflict() {
  const c = S.conflicts[0];
  renderHeader();
  if (!c) return;
  const { e } = c;
  const cur = fieldsOf(rawDoc(e.col, e.id));
  const name = `<b>${esc(docName(e))}</b>`;
  const more = S.conflicts.length > 1 ? `<p class="sheet-note">확인할 항목이 ${S.conflicts.length}건 있어요. 하나씩 물어볼게요.</p>` : '';
  if (c.kind === 'clash') {
    openSheet({
      title: '다른 사람이 먼저 고쳤어요', submit: '내 수정으로 바꾸기', danger: '지금 내용 유지', dangerPlain: true, noCancel: true,
      html: `<p class="sheet-note">${name} 항목을 오프라인에서 고치는 사이, 다른 사람이 같은 칸을 고쳤어요. 겹치지 않는 칸의 수정은 이미 올렸어요.</p>${diffTable(c.fields, e.changes, cur, '내 수정', '지금 내용')}${more}`,
      onSubmit: () => resolveConflict(true), onDanger: () => resolveConflict(false),
    });
  } else if (c.kind === 'deleted') {
    openSheet({
      title: '다른 사람이 삭제한 항목이에요', submit: '내 수정으로 다시 만들기', danger: '삭제된 대로 두기', dangerPlain: true, noCancel: true,
      html: `<p class="sheet-note">${name} 항목을 오프라인에서 고치는 사이, 다른 사람이 이 항목을 삭제했어요.</p>${diffTable(Object.keys(e.changes), e.changes, e.snapshot || {}, '내 수정', '삭제 전 내용')}${more}`,
      onSubmit: () => resolveConflict(true), onDanger: () => resolveConflict(false),
    });
  } else {
    openSheet({
      title: '다른 사람이 고친 항목이에요', submit: '남겨두기', danger: '그래도 삭제', noCancel: true,
      html: `<p class="sheet-note">${name} 항목을 오프라인에서 삭제했는데, 그사이 다른 사람이 이 항목을 고쳤어요.</p>${diffTable(c.fields, e.snapshot || {}, cur, '내가 본 내용', '지금 내용')}${more}`,
      onSubmit: () => resolveConflict(false), onDanger: () => resolveConflict(true),
    });
  }
}
function resolveConflict(useMine) {
  const c = S.conflicts.shift();
  if (!c) return;
  const { e } = c;
  const ref = doc(fb.db, e.col, e.id);
  let msg = '지금 내용을 그대로 뒀어요.';
  if (c.kind === 'clash' && useMine) { updateDoc(ref, { ...e.changes, updatedAt: serverTimestamp() }).catch(warnErr); msg = '내 수정으로 바꿨어요.'; }
  if (c.kind === 'deleted') {
    if (useMine) { setDoc(ref, { ...(e.snapshot || {}), ...e.changes, updatedAt: serverTimestamp() }).catch(warnErr); msg = '내 수정으로 다시 만들었어요.'; } else msg = '삭제된 대로 뒀어요.';
  }
  if (c.kind === 'edited') { if (useMine) { deleteDoc(ref).catch(warnErr); msg = '삭제했어요.'; } else msg = '삭제하지 않고 남겨뒀어요.'; }
  dropEntry(e); saveOutbox();
  closeSheet();
  toast(msg);
  refreshModel();
  if (S.conflicts.length) setTimeout(showConflict, 300); else flushOutbox();
}

const TYPE_OPTS = Object.entries(TYPE).map(([k, [l]]) => [k, `${l} (${k})`]);
function openSessionSheet(id) {
  const s = id ? S.model.sessions.find(x => x.id === id) : null;
  if (id && !s) return;
  const base = s || { date: S.day || S.model.meta.start, type: 'Seminar', track: 'General', attendees: [...S.model.people] };
  openSheet({
    title: s ? '일정 수정' : '일정 추가', submit: '저장', danger: s ? '삭제' : '',
    fields: [
      { name: 'title', label: '제목', required: true, value: base.title, ph: '예: [SEC203] 멀티클라우드 통합 보안' },
      { name: 'date', label: '날짜', type: 'date', required: true, value: base.date, half: true },
      { name: 'type', label: '종류', type: 'select', options: TYPE_OPTS, value: base.type, half: true },
      { name: 'start', label: '시작', type: 'time', value: base.start, half: true },
      { name: 'end', label: '끝', type: 'time', value: base.end, half: true },
      { name: 'track', label: '트랙', type: 'select', options: [['General', 'General'], ['Security', 'Security']], value: base.track || 'General', half: true },
      { name: 'location', label: '장소', value: base.location, ph: '예: Venetian L2 · Venetian Theatre' },
      { name: 'attendees', label: '출장자', type: 'people', options: S.model.people, value: base.attendees },
      { name: 'people', label: '연사·참고', value: base.people },
      { name: 'note', label: '메모', type: 'textarea', rows: 6, value: base.note },
    ],
    onSubmit: v => {
      if (!v.title) { formErr('제목을 넣어주세요.'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date || '')) { formErr('날짜를 골라주세요.'); return; }
      if (v.start && v.end && v.end < v.start) { formErr('끝 시간이 시작보다 빨라요.'); return; }
      let attendees = [].concat(v.attendees || []);
      for (const n of String(v.attendees_extra || '').split(',').map(x => x.trim()).filter(Boolean)) if (!attendees.includes(n)) attendees.push(n);
      if (s && sameSet(attendees, s.attendees)) attendees = s.attendees; // 순서만 다른 건 바뀐 걸로 치지 않음
      const docId = s ? s.id : `s-${Date.now()}`;
      const data = { title: v.title, date: v.date, start: v.start || '', end: v.end || '', type: v.type, track: v.track, location: v.location || '', attendees, people: v.people || '', note: v.note || '' };
      S.day = v.date; S.open.add(docId); S.query = '';
      if (s) saveEdit('sessions', docId, data, s, '일정을 고쳤어요.'); else setDirect('sessions', docId, data, '일정을 추가했어요.');
      renderSchedule();
    },
    onDanger: () => { if (confirm('이 일정을 삭제할까요?')) removeDoc('sessions', s.id, '일정을 삭제했어요.'); },
  });
}

function openPlaceSheet(id) {
  const p = id ? S.model.places.find(x => x.id === id) : null;
  if (id && !p) return;
  const base = p || { c: S.cat !== 'all' && S.cat !== 'etc' ? S.cat : 'steak' };
  openSheet({
    title: p ? '장소 수정' : '장소 추가', submit: '저장', danger: p ? '삭제' : '',
    fields: [
      { name: 'k', label: '이름 (한글)', value: base.k, ph: '예: 피터 루거', half: true },
      { name: 'n', label: '이름 (영문)', value: base.n, ph: 'Peter Luger Steak House', half: true },
      { name: 'c', label: '분류', type: 'select', options: CATS.map(c => [c[0], c[2]]), value: base.c, half: true },
      { name: 'pr', label: '가격대', type: 'select', options: [['', '—'], ['$', '$'], ['$$', '$$'], ['$$$', '$$$'], ['$$$$', '$$$$']], value: base.pr, half: true },
      { name: 'at', label: '행사 일시 (메가존 행사)', value: base.at, ph: '2026-12-03 18:00–21:00' },
      { name: 't', label: '종류 설명', value: base.t, ph: '예: 브루클린식 스테이크하우스' },
      { name: 'v', label: '위치', value: base.v, ph: '예: 시저스 팰리스' },
      { name: 'h', label: '숙소 표시', type: 'select', options: [['', '—'], ['숙소 안', '숙소 안'], ['숙소', '숙소 (거리 계산 기준)']], value: base.h, half: true },
      { name: 'memo', label: '메모 배지', value: base.memo, ph: '예: 조식 가능', half: true },
      { name: 'd', label: '소개', type: 'textarea', rows: 3, value: base.d },
      { name: 'x', label: '방문 팁', type: 'textarea', rows: 3, value: base.x },
      { name: 'w', label: '공식 사이트', type: 'url', inputmode: 'url', value: base.w, ph: 'https://…' },
      { name: 'map', label: '지도 링크', type: 'url', inputmode: 'url', value: base.map, ph: 'https://maps.app.goo.gl/…' },
      { name: 'll', label: '좌표 (숙소와의 거리 계산)', value: Array.isArray(base.ll) ? base.ll.join(', ') : '', ph: '36.1133, -115.1750' },
      { name: 'm', label: '일정 연결 단어', value: base.m, help: '일정 제목·장소에 이 단어가 있으면 서로 연결해 보여줘요.' },
    ],
    onSubmit: v => {
      if (!v.k && !v.n) { formErr('이름을 넣어주세요.'); return; }
      let ll = null;
      if (v.ll) {
        const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(v.ll);
        if (!m) { formErr('좌표는 "36.1133, -115.1750"처럼 넣어주세요.'); return; }
        ll = [+m[1], +m[2]];
      }
      if (v.h === '숙소' && (!p || p.h !== '숙소')) for (const o of S.model.places) if (o.h === '숙소' && o.id !== (p && p.id)) commitChanges('places', o.id, { h: '' });
      const docId = p ? p.id : `p-${Date.now()}`;
      const data = { k: v.k || '', n: v.n || '', c: v.c, pr: v.pr || '', at: v.at || '', t: v.t || '', v: v.v || '', h: v.h || '', memo: v.memo || '', d: v.d || '', x: v.x || '', w: v.w || '', map: v.map || '', ll, m: v.m || '' };
      S.open.add('p:' + docId); S.cat = data.c;
      if (p) saveEdit('places', docId, data, p, '장소를 고쳤어요.'); else setDirect('places', docId, data, '장소를 추가했어요.');
      renderPlaces();
    },
    onDanger: () => { if (confirm('이 장소를 삭제할까요?')) removeDoc('places', p.id, '장소를 삭제했어요.'); },
  });
}

function openTripSheet() {
  const m = S.model.meta;
  openSheet({
    title: '여행 정보 수정', submit: '저장',
    fields: [
      { name: 'title', label: '이름', required: true, value: m.title },
      { name: 'start', label: '시작일', type: 'date', value: m.start, half: true },
      { name: 'end', label: '종료일', type: 'date', value: m.end, half: true },
      { name: 'location', label: '장소', value: m.location },
      { name: 'mapUrl', label: '구글 공유맵 링크', type: 'url', inputmode: 'url', value: m.mapUrl, ph: 'https://maps.app.goo.gl/…', help: '구글 지도에서 장소 목록을 공유한 링크예요. 맛집 화면과 정보 화면에 버튼으로 나와요.' },
      { name: 'note', label: '메모', type: 'textarea', rows: 3, value: m.note },
    ],
    onSubmit: v => {
      if (!v.title) { formErr('이름을 넣어주세요.'); return; }
      if (v.start && v.end && v.end < v.start) { formErr('종료일이 시작일보다 빨라요.'); return; }
      if (v.mapUrl && !safeUrl(v.mapUrl)) { formErr('공유맵 링크는 https://로 시작해야 해요.'); return; }
      const data = { title: v.title, start: v.start || '', end: v.end || '', location: v.location || '', mapUrl: v.mapUrl || '', note: v.note || '' };
      if (rawDoc('meta', 'trip')) saveEdit('meta', 'trip', data, m, '여행 정보를 고쳤어요.'); else setDirect('meta', 'trip', data, '여행 정보를 저장했어요.');
    },
  });
}

/* ---------- 이벤트 ---------- */
let toastTimer;
function toast(msg) {
  if (!msg) return;
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3400);
}

function setTab(tab) {
  S.tab = tab; store.set(K.tab, tab);
  render();
  window.scrollTo(0, 0);
}

async function forgetDevice() {
  if (!confirm(S.outbox.length ? `아직 올라가지 않은 오프라인 수정 ${S.outbox.length}건도 함께 사라져요. 이 기기에서 지울까요?` : '이 기기에서 로그인 정보와 저장된 일정을 지울까요?')) return;
  stopListeners();
  try { await signOut(fb.auth); } catch { /* 무시 */ }
  try { await terminate(fb.db); await clearIndexedDbPersistence(fb.db); } catch { /* 무시 */ }
  Object.values(K).forEach(store.del);
  location.reload();
}

document.addEventListener('click', e => {
  const tabBtn = e.target.closest('.tabs button');
  if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
  if (e.target.closest('#syncPill')) { if (S.conflicts.length) showConflict(); else checkServer(); return; }
  if (e.target.closest('#editBtn')) { toggleEdit(); return; }
  if (e.target.closest('#fab')) { if (S.tab === 'places') openPlaceSheet(); else openSessionSheet(); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const v = el.dataset.v;
  switch (el.dataset.act) {
    case 'person': S.person = v; store.set(K.person, v); renderSchedule(); break;
    case 'day': S.day = v; renderScheduleBody(); break;
    case 'toggle':
      if (S.open.has(v)) S.open.delete(v); else S.open.add(v);
      if (S.tab === 'places') renderPlaces(); else renderScheduleBody();
      break;
    case 'cat': S.cat = v; store.set(K.cat, v); renderPlaces(); break;
    case 'goPlace': {
      S.open.add('p:' + v); S.cat = 'all'; S.tab = 'places'; store.set(K.tab, 'places');
      render();
      const target = document.getElementById('place-' + v);
      if (target) target.scrollIntoView({ block: 'center' });
      break;
    }
    case 'check': checkServer(); break;
    case 'install': doInstall(); break;
    case 'copyLink':
      if (navigator.clipboard) navigator.clipboard.writeText(appUrl()).then(() => toast('주소를 복사했어요. 브라우저 주소창에 붙여넣어 주세요.'), () => toast('복사하지 못했어요. 주소를 길게 눌러 복사해주세요.'));
      else toast('주소를 길게 눌러 복사해주세요.');
      break;
    case 'forget': forgetDevice(); break;
    case 'editSession': openSessionSheet(v); break;
    case 'delSession': if (confirm('이 일정을 삭제할까요?')) removeDoc('sessions', v, '일정을 삭제했어요.'); break;
    case 'editPlace': openPlaceSheet(v); break;
    case 'delPlace': if (confirm('이 장소를 삭제할까요?')) removeDoc('places', v, '장소를 삭제했어요.'); break;
    case 'editTrip': openTripSheet(); break;
    case 'setEditPw': openSetEditPwSheet(false); break;
    case 'closeSheet': closeSheet(); break;
    case 'sheetDanger': if (S.sheet && S.sheet.onDanger) S.sheet.onDanger(); break;
  }
});

$('sheetForm').addEventListener('submit', e => {
  e.preventDefault();
  if (S.sheet && S.sheet.onSubmit) S.sheet.onSubmit(formValues());
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
document.addEventListener('input', e => { if (e.target.id === 'q') { S.query = e.target.value; renderScheduleBody(); } });

$('lockForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!fb) return;
  const input = $('pin'), btn = $('unlockBtn'), msg = $('lockMsg');
  btn.disabled = true; msg.className = 'lock-msg ok'; msg.textContent = '확인하는 중…';
  try {
    await signInWithEmailAndPassword(fb.auth, VIEWER_EMAIL, viewerPassword(input.value.trim()));
    input.value = '';
    msg.textContent = '';
  } catch (err) {
    const code = err && err.code;
    msg.className = 'lock-msg';
    msg.textContent = code === 'auth/network-request-failed' ? '처음 한 번은 인터넷 연결이 필요해요.'
      : code === 'auth/too-many-requests' ? '시도가 너무 많아요. 잠시 후 다시 해주세요.'
        : '비밀번호가 맞지 않아요.';
    input.select();
  } finally { btn.disabled = false; }
});

window.addEventListener('online', () => { renderHeader(); if (fb) enableNetwork(fb.db).catch(() => {}); });
window.addEventListener('offline', renderHeader);
// 앱을 다시 띄웠을 때나 1분마다: 날짜가 바뀌었으면 오늘 일정으로 옮기고 '진행 중' 표시를 갱신합니다.
function refreshToday() {
  if (document.visibilityState !== 'visible' || !S.model || !S.model.days.length) return;
  if (S.autoDate && S.autoDate !== todayStr()) S.day = defaultDay();
  if (S.tab === 'schedule' && $('schedBody') && !S.query) renderScheduleBody();
}
document.addEventListener('visibilitychange', refreshToday);
setInterval(refreshToday, 60 * 1000);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; refreshInstallUi(); });
window.addEventListener('appinstalled', () => { S.installEvt = null; toast('홈 화면에 추가했어요.'); refreshInstallUi(); });

/* ---------- 시작 ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!firebaseConfig) {
  showLock();
} else {
  fb = initFirebase();
  // 로그인 상태는 기기 저장소에서 바로 확인되므로, 확인 전에는 잠금 화면을 띄우지 않습니다.
  onAuthStateChanged(fb.auth, user => {
    if (user && user.email === VIEWER_EMAIL) {
      S.user = user;
      S.outbox = loadOutbox();
      startListeners();
      showApp();
    } else {
      S.user = null; S.edit = false;
      stopListeners();
      showLock();
    }
  });
}
