#!/usr/bin/env node
// 아티팩트 데이터를 암호화된 data.enc.json으로 만들고 갱신하는 도구.
// 비밀번호는 SYNC_PIN 환경변수로만 받습니다(저장소에 남기지 않음).
//
//   build    --raw <dir> [--source-url <url>]   원본 JSONL 3개(sessions/places/meta)로 새로 만들기
//   manifest                                   현재 파일의 문서 id와 version 목록 출력
//   update   --delta <dir> --ids <ids.json>     바뀐 문서만 반영(ids.json에 없는 id는 삭제)
//   dump     --out <dir>                        현재 파일을 원본 JSONL로 풀어 쓰기(확인용)
//
// 공통 옵션: --file <path> (기본: 저장소 루트의 data.enc.json), --force (변경 없어도 다시 쓰기)
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLLECTIONS = ['sessions', 'places', 'meta'];
const ITERATIONS = 600000;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => { const i = args.indexOf('--' + name); return i > 0 ? args[i + 1] : def; };
const flag = name => args.includes('--' + name);
const FILE = path.resolve(opt('file', path.join(ROOT, 'data.enc.json')));

const b64 = buf => Buffer.from(buf).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));

function pin() {
  const p = process.env.SYNC_PIN;
  if (!p) { console.error('SYNC_PIN 환경변수에 앱 비밀번호를 넣어주세요.'); process.exit(2); }
  return p;
}

async function deriveKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function readEnc() {
  return fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
}

async function decryptFile(enc) {
  const key = await deriveKey(pin(), unb64(enc.kdf.salt), enc.kdf.iterations);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(enc.iv) }, key, unb64(enc.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    console.error('기존 data.enc.json을 풀 수 없습니다. SYNC_PIN이 맞는지 확인하세요.');
    process.exit(2);
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map((l, i) => {
    const d = JSON.parse(l);
    if (!d.id || typeof d.data !== 'object') throw new Error(`${file}:${i + 1} 형식 오류 (id, data 필요)`);
    return { id: d.id, version: d.version ?? null, updatedAt: d.updatedAt ?? null, data: d.data };
  });
}

const byId = list => Object.fromEntries(list.map(d => [d.id, d]));
const sortDocs = list => [...list].sort((a, b) => a.id.localeCompare(b.id));
const sig = col => JSON.stringify(sortDocs(col).map(d => [d.id, d.version, d.updatedAt, d.data]));

function summarize(prev, next) {
  const out = [];
  for (const c of COLLECTIONS) {
    const a = byId(prev?.collections?.[c] || []), b = byId(next.collections[c]);
    const added = Object.keys(b).filter(id => !a[id]).length;
    const removed = Object.keys(a).filter(id => !b[id]).length;
    const changed = Object.keys(b).filter(id => a[id] && JSON.stringify(a[id]) !== JSON.stringify(b[id])).length;
    out.push(`${c}: ${Object.keys(b).length}건 (추가 ${added} · 수정 ${changed} · 삭제 ${removed})`);
  }
  return out.join('\n');
}

async function write(prevEnc, prevPayload, collections, sourceUrl) {
  const unchanged = prevPayload && COLLECTIONS.every(c => sig(prevPayload.collections[c] || []) === sig(collections[c]))
    && (prevPayload.sourceUrl || null) === (sourceUrl || null);
  const all = COLLECTIONS.flatMap(c => collections[c]);
  const sourceUpdatedAt = all.map(d => d.updatedAt).filter(Boolean).sort().pop() || null;
  const payload = { format: 1, generatedAt: new Date().toISOString(), sourceUpdatedAt, sourceUrl: sourceUrl || null, collections };
  console.log(summarize(prevPayload, payload));
  if (unchanged && !flag('force')) { console.log('변경 없음: 파일을 다시 쓰지 않았습니다.'); return false; }

  // 기기에 저장된 키가 계속 맞도록 기존 salt와 반복 횟수를 그대로 씁니다.
  const salt = prevEnc ? unb64(prevEnc.kdf.salt) : crypto.getRandomValues(new Uint8Array(16));
  const iterations = prevEnc ? prevEnc.kdf.iterations : ITERATIONS;
  const key = await deriveKey(pin(), salt, iterations);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  const enc = { format: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) }, iv: b64(iv), ct: b64(ct) };
  fs.writeFileSync(FILE, JSON.stringify(enc) + '\n');
  console.log(`저장: ${path.relative(process.cwd(), FILE)} (원본 최종 수정 ${sourceUpdatedAt})`);
  return true;
}

async function main() {
  const prevEnc = readEnc();
  const prevPayload = prevEnc ? await decryptFile(prevEnc) : null;

  if (cmd === 'build') {
    const raw = opt('raw');
    if (!raw) throw new Error('--raw <dir> 가 필요합니다.');
    const collections = Object.fromEntries(COLLECTIONS.map(c => [c, sortDocs(readJsonl(path.join(raw, c + '.jsonl')))]));
    if (!collections.sessions.length || !collections.meta.length) throw new Error('sessions.jsonl과 meta.jsonl이 비어 있습니다.');
    await write(prevEnc, prevPayload, collections, opt('source-url', prevPayload?.sourceUrl));
  } else if (cmd === 'manifest') {
    if (!prevPayload) throw new Error('data.enc.json이 없습니다.');
    const m = Object.fromEntries(COLLECTIONS.map(c => [c, Object.fromEntries((prevPayload.collections[c] || []).map(d => [d.id, d.version]))]));
    console.log(JSON.stringify({ generatedAt: prevPayload.generatedAt, sourceUpdatedAt: prevPayload.sourceUpdatedAt, ...m }, null, 1));
  } else if (cmd === 'update') {
    if (!prevPayload) throw new Error('data.enc.json이 없습니다. 먼저 build 하세요.');
    const delta = opt('delta'), idsFile = opt('ids');
    if (!delta || !idsFile) throw new Error('--delta <dir> 와 --ids <ids.json> 이 필요합니다.');
    const ids = JSON.parse(fs.readFileSync(idsFile, 'utf8'));
    const collections = {};
    for (const c of COLLECTIONS) {
      if (!Array.isArray(ids[c])) throw new Error(`ids.json에 ${c} 목록이 없습니다.`);
      const merged = byId(prevPayload.collections[c] || []);
      for (const d of readJsonl(path.join(delta, c + '.jsonl'))) merged[d.id] = d;
      const keep = new Set(ids[c]);
      const missing = ids[c].filter(id => !merged[id]);
      if (missing.length) throw new Error(`${c}: 새 문서인데 delta에 내용이 없습니다 → ${missing.join(', ')}`);
      collections[c] = sortDocs(Object.values(merged).filter(d => keep.has(d.id)));
    }
    await write(prevEnc, prevPayload, collections, prevPayload.sourceUrl);
  } else if (cmd === 'dump') {
    if (!prevPayload) throw new Error('data.enc.json이 없습니다.');
    const out = opt('out');
    if (!out) throw new Error('--out <dir> 가 필요합니다.');
    fs.mkdirSync(out, { recursive: true });
    for (const c of COLLECTIONS) fs.writeFileSync(path.join(out, c + '.jsonl'), (prevPayload.collections[c] || []).map(d => JSON.stringify(d)).join('\n') + '\n');
    console.log(`풀어 쓴 위치: ${out}`);
  } else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n'));
    process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
