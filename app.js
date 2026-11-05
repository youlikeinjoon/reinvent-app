'use strict';
// re:Invent 2026 출장 일정 웹앱
// - data.enc.json(암호화된 일정·장소)을 받아 이 기기에 저장하고, 오프라인이면 저장본을 보여줍니다.
// - 비밀번호는 처음 한 번만 묻고, 풀린 키를 이 기기에만 보관합니다.

const APP_VERSION = '1.0.0';
const DATA_URL = 'data.enc.json';
const K = { key: 'rv.key', keyId: 'rv.keyId', enc: 'rv.enc', fetchedAt: 'rv.fetchedAt', person: 'rv.person', tab: 'rv.tab', cat: 'rv.cat' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

const S = {
  enc: null, data: null, key: null, model: null,
  fetchedAt: store.get(K.fetchedAt), online: navigator.onLine, syncing: false,
  tab: store.get(K.tab) || 'schedule', person: store.get(K.person) || '', cat: store.get(K.cat) || 'all',
  day: null, query: '', open: new Set(), installEvt: null,
};

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = s => esc(s).replace(/https?:\/\/[^\s<>"')]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
const pad = n => String(n).padStart(2, '0');

/* ---------- 암호화 ---------- */
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64e = buf => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
const kdfId = enc => `${enc.kdf.salt}:${enc.kdf.iterations}`;

async function deriveKey(pass, kdf) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64d(kdf.salt), iterations: kdf.iterations }, base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
}
async function decryptWith(key, enc) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(enc.iv) }, key, b64d(enc.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function tryStoredKey() {
  if (!S.enc || store.get(K.keyId) !== kdfId(S.enc)) return false;
  const raw = store.get(K.key);
  if (!raw) return false;
  try {
    const key = await crypto.subtle.importKey('raw', b64d(raw), { name: 'AES-GCM' }, false, ['decrypt']);
    setData(await decryptWith(key, S.enc));
    S.key = key;
    return true;
  } catch { return false; }
}

/* ---------- 데이터 받기·동기화 ---------- */
async function fetchRemote() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(String(res.status));
    const enc = await res.json();
    if (!enc || !enc.ct || !enc.kdf) throw new Error('format');
    S.online = true;
    return enc;
  } catch {
    S.online = false;
    return null;
  } finally { clearTimeout(timer); }
}

async function applyRemote(enc, manual) {
  S.fetchedAt = new Date().toISOString();
  store.set(K.fetchedAt, S.fetchedAt);
  const same = S.enc && S.enc.ct === enc.ct;
  S.enc = enc;
  store.set(K.enc, JSON.stringify(enc));
  if (!S.data) {
    if (await tryStoredKey()) showApp(); else showLock();
    return;
  }
  if (same) { if (manual) toast('이미 최신 내용이에요.'); renderHeader(); return; }
  const prev = S.data;
  try {
    const next = S.key && store.get(K.keyId) === kdfId(enc) ? await decryptWith(S.key, enc) : null;
    if (!next) throw new Error('key');
    setData(next);
    render();
    toast(changeSummary(prev, next));
  } catch {
    S.data = null; S.key = null; S.model = null;
    store.del(K.key); store.del(K.keyId);
    showLock('비밀번호가 바뀌었어요. 새 비밀번호를 입력해주세요.');
  }
}

async function sync(manual) {
  if (S.syncing) return;
  S.syncing = true; renderHeader();
  const enc = await fetchRemote();
  S.syncing = false;
  if (enc) await applyRemote(enc, manual);
  else if (manual) toast('인터넷에 연결되어 있지 않아요. 마지막으로 받은 내용을 보여드려요.');
  renderHeader();
}

function changeSummary(prev, next) {
  const diff = col => {
    const a = new Map((prev.collections[col] || []).map(d => [d.id, d.version]));
    const b = new Map((next.collections[col] || []).map(d => [d.id, d.version]));
    let add = 0, mod = 0, del = 0;
    for (const [id, v] of b) { if (!a.has(id)) add++; else if (a.get(id) !== v) mod++; }
    for (const id of a.keys()) if (!b.has(id)) del++;
    return add + mod + del ? `${add ? `추가 ${add}` : ''}${mod ? ` 수정 ${mod}` : ''}${del ? ` 삭제 ${del}` : ''}`.trim() : '';
  };
  const parts = [['일정', diff('sessions')], ['장소', diff('places')]].filter(p => p[1]).map(p => `${p[0]} ${p[1]}`);
  return parts.length ? `새 내용을 받았어요 · ${parts.join(' · ')}` : '새 내용을 받았어요.';
}

/* ---------- 데이터 정리 ---------- */
function setData(payload) { S.data = payload; S.model = buildModel(payload); }

function buildModel(p) {
  const c = p.collections;
  const metaDoc = (c.meta || []).find(d => d.id === 'trip') || (c.meta || [])[0];
  const meta = { title: 'AWS re:Invent 2026', start: '', end: '', location: '', note: '', ...(metaDoc ? metaDoc.data : {}) };
  const sessions = (c.sessions || []).map(d => ({ ...d.data, id: d.id, attendees: d.data.attendees || [] }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.start || '99').localeCompare(b.start || '99') || (a.title || '').localeCompare(b.title || ''));
  const places = (c.places || []).map(d => ({ ...d.data, id: d.id }));
  const hotel = places.find(x => x.h === '숙소') || null;
  let people = [];
  const widest = sessions.reduce((m, s) => (s.attendees.length > (m ? m.attendees.length : 0) ? s : m), null);
  if (widest) people = [...widest.attendees];
  for (const s of sessions) for (const a of s.attendees) if (!people.includes(a)) people.push(a);
  const dates = new Set(sessions.map(s => s.date).filter(Boolean));
  if (meta.start && meta.end) for (let d = meta.start; d <= meta.end; d = addDays(d, 1)) dates.add(d);
  return { meta, sessions, places, hotel, people, days: [...dates].sort() };
}

/* ---------- 날짜·시간 ---------- */
const WD = ['일', '월', '화', '수', '목', '금', '토'];
function ymd(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }; }
function addDays(s, n) { const p = ymd(s); const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
const md = s => { const p = ymd(s); return `${p.m}/${p.d}`; };
const wd = s => WD[ymd(s).wd];
const dayLabel = s => `${md(s)} (${wd(s)})`;
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const toMin = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
function stamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtAt(at) {
  // "2026-12-03 18:00–21:00" 또는 "2026-11-30~12-03 09:00–17:00"
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
  if (!a || !b) return null;
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
  return km < 1 ? `숙소에서 ${Math.round(km * 1000 / 10) * 10}m` : `숙소에서 ${km.toFixed(1)}km`;
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
  const m = $('lockMsg');
  if (msg) { m.textContent = msg; m.className = 'lock-msg'; }
  else if (!S.enc) { m.textContent = S.online ? '데이터를 받는 중…' : '인터넷에 연결한 뒤 다시 열어주세요. 처음 한 번은 데이터를 받아야 해요.'; m.className = 'lock-msg ok'; }
  else { m.textContent = ''; }
  $('unlockBtn').disabled = !S.enc;
  $('lockInstall').innerHTML = installHtml(true);
}
function showApp() {
  $('lock').hidden = true;
  $('app').hidden = false;
  if (!S.day) S.day = defaultDay();
  render();
}
function defaultDay() {
  const days = S.model.days, t = todayStr();
  if (days.includes(t)) return t;
  if (days.length && t > days[days.length - 1]) return days[days.length - 1];
  return days[0] || t;
}

function render() {
  if (!S.data) return;
  renderHeader();
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
  if (S.tab === 'places') renderPlaces();
  else if (S.tab === 'info') renderInfo();
  else renderSchedule();
}

function renderHeader() {
  if (!S.model) return;
  const { meta } = S.model;
  $('tTitle').textContent = meta.title || 're:Invent 2026';
  $('tSub').textContent = [meta.location, meta.start && meta.end ? `${md(meta.start)}–${md(meta.end)}` : ''].filter(Boolean).join(' · ');
  const pill = $('syncPill');
  pill.classList.toggle('busy', S.syncing);
  pill.classList.toggle('offline', !S.online && !S.syncing);
  $('syncText').textContent = S.syncing ? '동기화 중' : S.online ? `${stamp(S.fetchedAt)} 동기화` : `오프라인 · ${stamp(S.fetchedAt) || '저장본'}`;
}

/* ---------- 일정 ---------- */
const ICON_SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_MAP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.2" fill="currentColor"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const forPerson = s => !S.person || !s.attendees.length || s.attendees.includes(S.person);
function matchesQuery(s, q) {
  return [s.title, s.location, s.note, s.people, s.type, s.track].some(v => String(v || '').toLowerCase().includes(q));
}

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
  if (!box) return;
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
    <p class="hint">시간은 모두 라스베이거스 현지 시간이에요. 카드를 누르면 자세한 내용이 보여요.</p>
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
        <div class="badges"><span class="badge ${cls}">${esc(label)}</span>${s.track === 'Security' ? '<span class="badge sec">Security</span>' : ''}${st === 'now' ? '<span class="badge now">진행 중</span>' : ''}${isNext ? '<span class="badge next">다음</span>' : ''}</div>
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
      ${p ? `<button class="btn" data-act="goPlace" data-v="${esc(p.id)}">장소 안내 보기</button>` : ''}
    </div>
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
    </div>` : ''}
  </li>`;
}

/* ---------- 정보 ---------- */
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function installHtml(onLock) {
  if (isStandalone()) return '';
  if (isIOS()) {
    return `<div class="install ${onLock ? '' : 'panel'}"><h3>홈 화면에 앱으로 설치하기</h3>
      <ol><li>Safari 아래쪽 <b>공유 버튼</b>(네모에 위쪽 화살표)을 누르세요.</li><li><b>홈 화면에 추가</b> → <b>추가</b>를 누르세요.</li><li>홈 화면의 <b>re:Invent</b> 아이콘으로 여세요.</li></ol>
      <p style="margin-top:8px">아이콘으로 처음 열 때 비밀번호를 한 번 더 물을 수 있어요.</p></div>`;
  }
  return `<div class="install ${onLock ? '' : 'panel'}"><h3>홈 화면에 앱으로 설치하기</h3>
    <ol><li>Chrome 오른쪽 위 <b>⋮</b> 메뉴를 누르세요.</li><li><b>홈 화면에 추가</b> 또는 <b>앱 설치</b>를 누르세요.</li></ol>
    ${S.installEvt ? '<div class="actions"><button class="btn green" data-act="install">지금 설치</button></div>' : ''}</div>`;
}

function renderInfo() {
  const { meta, people, sessions, places } = S.model;
  const d = S.data;
  $('view').innerHTML = `
    <div class="hero">
      <small>EXECUTIVE TRIP PLANNER</small>
      <h2>${esc(meta.title)}</h2>
      ${meta.note ? `<p>${esc(meta.note)}</p>` : ''}
      <div class="pills">
        ${meta.start && meta.end ? `<span>${esc(dayLabel(meta.start))} ~ ${esc(dayLabel(meta.end))}</span>` : ''}
        ${meta.location ? `<span>${esc(meta.location)}</span>` : ''}
      </div>
    </div>
    <div class="panel">
      <h3>출장자</h3>
      <p>${people.map(esc).join(' · ') || '—'}</p>
      <p class="muted">일정 ${sessions.length}건 · 맛집·장소 ${places.length}건</p>
    </div>
    <div class="panel">
      <h3>동기화</h3>
      <dl class="rows">
        <dt>이 기기가 받은 시각</dt><dd>${esc(stamp(S.fetchedAt) || '—')}${S.online ? '' : ' (지금 오프라인)'}</dd>
        <dt>원본 마지막 수정</dt><dd>${esc(stamp(d.sourceUpdatedAt) || '—')}</dd>
        <dt>앱에 반영한 시각</dt><dd>${esc(stamp(d.generatedAt) || '—')}</dd>
      </dl>
      <p class="muted">‘지금 동기화’는 앱에 올라간 최신본을 받아와요. 원본 플래너에서 고친 내용은 앱에 반영된 뒤에 나타나요. 인터넷이 끊기면 마지막으로 받은 내용을 그대로 보여드려요.</p>
      <div class="actions"><button class="btn green" data-act="sync" ${S.syncing ? 'disabled' : ''}>지금 동기화</button>
      ${d.sourceUrl ? `<a class="btn" href="${esc(d.sourceUrl)}" target="_blank" rel="noopener">${ICON_LINK}원본 플래너</a>` : ''}</div>
    </div>
    ${installHtml(false)}
    <div class="panel">
      <h3>이 기기</h3>
      <p class="muted">기억된 비밀번호와 저장된 일정을 이 기기에서 지웁니다. 다시 열면 비밀번호를 물어요.</p>
      <div class="actions"><button class="btn danger" data-act="forget">이 기기에서 지우기</button></div>
    </div>
    <p class="foot">버전 ${APP_VERSION} · 일정과 장소 정보는 원본 플래너 기준이며, 행사 시간과 영업시간은 공식 안내를 확인하세요.</p>`;
}

/* ---------- 이벤트 ---------- */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function setTab(tab) {
  S.tab = tab; store.set(K.tab, tab);
  render();
  window.scrollTo(0, 0);
}

document.addEventListener('click', async e => {
  const tabBtn = e.target.closest('.tabs button');
  if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
  if (e.target.closest('#syncPill')) { sync(true); return; }
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
    case 'sync': await sync(true); if (S.tab === 'info') renderInfo(); break;
    case 'install':
      if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; }
      break;
    case 'forget':
      if (!confirm('이 기기에서 비밀번호와 저장된 일정을 지울까요?')) return;
      for (const k of Object.values(K)) store.del(k);
      S.data = null; S.key = null; S.model = null; S.enc = null;
      showLock('지웠어요. 다시 쓰려면 비밀번호를 입력하세요.');
      sync(false);
      break;
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'q') { S.query = e.target.value; renderScheduleBody(); }
});

$('lockForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('pin'), btn = $('unlockBtn'), msg = $('lockMsg');
  if (!S.enc) { showLock(); return; }
  btn.disabled = true; msg.className = 'lock-msg ok'; msg.textContent = '여는 중…';
  try {
    const key = await deriveKey(input.value.trim(), S.enc.kdf);
    let payload;
    try { payload = await decryptWith(key, S.enc); } catch { throw new Error('pin'); }
    S.key = key;
    store.set(K.key, b64e(await crypto.subtle.exportKey('raw', key)));
    store.set(K.keyId, kdfId(S.enc));
    setData(payload);
    input.value = '';
    showApp();
  } catch (err) {
    msg.className = 'lock-msg';
    msg.textContent = err.message === 'pin' ? '비밀번호가 맞지 않아요.' : '이 브라우저에서는 열 수 없어요. 최신 Safari나 Chrome을 써주세요.';
    input.select();
  } finally { btn.disabled = !S.enc; }
});

window.addEventListener('online', () => { S.online = true; sync(false); });
window.addEventListener('offline', () => { S.online = false; renderHeader(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.data) return;
  const age = Date.now() - new Date(S.fetchedAt || 0).getTime();
  if (age > 10 * 60 * 1000) sync(false);
  else if (S.tab === 'schedule') renderScheduleBody(); // '진행 중' 표시 갱신
});
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; if (S.tab === 'info' && S.data) renderInfo(); });

/* ---------- 시작 ---------- */
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { const c = store.get(K.enc); if (c) S.enc = JSON.parse(c); } catch { S.enc = null; }
  if (S.enc && await tryStoredKey()) showApp(); else showLock();
  await sync(false);
  if (!S.data && $('lock').hidden === false) showLock();
}

if (!window.crypto || !crypto.subtle) {
  document.body.innerHTML = '<p style="padding:32px;font-family:sans-serif">이 브라우저에서는 열 수 없어요. 최신 Safari나 Chrome으로 열어주세요.</p>';
} else {
  boot();
}
