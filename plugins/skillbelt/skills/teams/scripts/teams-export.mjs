#!/usr/bin/env node
/*
 * teams-export.mjs — pull your own Microsoft Teams chats to JSON.
 *
 * Drives a real Chrome with a dedicated profile at ~/.teams-export/profile.
 * You sign in once (`login`); after that every run is unattended. All calls
 * go to Microsoft's own endpoints from inside the authenticated page, and the
 * JSON is written straight to disk — nothing is uploaded anywhere.
 *
 *   node teams-export.mjs login                 sign in once (opens a window)
 *   node teams-export.mjs list                  list your conversations
 *   node teams-export.mjs export <n|id> [opts]  export one conversation
 *   node teams-export.mjs export --all [opts]   export all of them
 *   node teams-export.mjs wipe                  delete the profile + session
 *
 * Options: --since 2026-01-01   --out <dir>   --headed   --raw   --include-system
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Code lives wherever the plugin is installed; data must NOT, or a plugin
// update would wipe the login session and the collected corpus.
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TEAMS_EXPORT_HOME || join(homedir(), '.teams-export');

const PROFILE_DIR = join(DATA_DIR, 'profile');
const DEFAULT_OUT = join(DATA_DIR, 'out');
const CONV_CACHE = join(DATA_DIR, 'conversations.json');
const STATE_FILE = join(DATA_DIR, 'state.json');
const PAGE_API = readFileSync(join(HERE, 'page-api.js'), 'utf8');
const TEAMS_URL = 'https://teams.microsoft.com/';

/**
 * playwright-core is installed into DATA_DIR (see `setup`) rather than next to
 * this script, because the plugin directory is replaced on every update. Fall
 * back to normal resolution so a plain local checkout still works.
 */
async function loadChromium() {
  const vendored = join(DATA_DIR, 'node_modules', 'playwright-core', 'index.mjs');
  try {
    if (existsSync(vendored)) return (await import(pathToFileURL(vendored).href)).chromium;
    return (await import('playwright-core')).chromium;
  } catch {
    throw new Error(
      'playwright-core 를 찾을 수 없습니다. 먼저 설치하세요:\n'
      + `   node ${join(HERE, 'teams-export.mjs')} setup`,
    );
  }
}

// ── arg parsing ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const positional = argv.slice(1).filter((a, i, arr) => {
  if (a.startsWith('--')) return false;
  const prev = arr[i - 1];
  return !(prev && prev.startsWith('--') && opt(prev.slice(2)) === a);
});

const log = (...a) => console.error(...a);

// ── browser plumbing ───────────────────────────────────────────────────
async function open({ headless }) {
  if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  const chromium = await loadChromium();
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    viewport: headless ? { width: 1440, height: 900 } : null,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  // Injected before any page script on every navigation. This route bypasses
  // the page's CSP — evaluating the source as a string from inside the page
  // would hit Teams' `script-src` (no 'unsafe-eval') and throw.
  await ctx.addInitScript({ content: PAGE_API });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

/** True once MSAL has a usable IC3 token on the current origin. */
const tokensReady = (page) =>
  page.evaluate(() => (window.__tx ? window.__tx.ready() : false)).catch(() => false);

/** Load Teams and wait until MSAL has usable tokens. */
async function boot(page, { timeoutMs = 120000, quiet = false } = {}) {
  await page.goto(TEAMS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    if (await tokensReady(page)) return true;
    if (!quiet && !announced) { log('   토큰 대기 중…'); announced = true; }
    await page.waitForTimeout(2000);
  }
  return false;
}

async function withTeams(fn, { headless } = {}) {
  const wantHeadless = headless ?? !flag('headed');
  const { ctx, page } = await open({ headless: wantHeadless });
  try {
    if (!(await boot(page))) {
      throw new Error(
        wantHeadless
          ? '로그인 세션이 없거나 만료됐습니다. `node teams-export.mjs login` 을 먼저 실행하세요.\n'
            + '   (조직 정책상 headless 가 막히는 경우 --headed 를 붙여 다시 시도)'
          : '로그인 세션이 없거나 만료됐습니다. `node teams-export.mjs login` 을 먼저 실행하세요.',
      );
    }
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

// ── message shaping ────────────────────────────────────────────────────
const stripHtml = (s) =>
  String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const mriUuid = (mri) => {
  const m = String(mri || '').match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return m ? m[1] : null;
};

function shape(msgs, { includeSystem, raw }) {
  const kept = msgs.filter((m) => {
    if (raw || includeSystem) return true;
    const t = m.messagetype || '';
    return t.startsWith('RichText') || t === 'Text';
  });
  if (raw) return kept;
  return kept
    .map((m) => ({
      id: m.id || m.clientmessageid || null,
      time: m.composetime || m.originalarrivaltime || null,
      from: m.imdisplayname || null,
      fromMri: m.from || null,
      type: m.messagetype || null,
      text: stripHtml(m.content),
      html: m.content || null,
    }))
    .filter((m) => m.text || m.html)
    .sort((a, b) => Date.parse(a.time || 0) - Date.parse(b.time || 0));
}

const slug = (s) =>
  String(s || 'chat').replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'chat';

// ── label helper ───────────────────────────────────────────────────────
function labelFor(c, names) {
  if (c.shortTitle) return c.shortTitle;   // Teams' own precomputed sidebar title
  if (c.topic) return c.topic;
  const other = mriUuid(c.id);
  if (other && names[other]) return names[other];
  if (c.lastMessageFrom) return `(무제) ~ ${c.lastMessageFrom}`;
  return c.id;
}

async function enrich(page, convs) {
  const needsName = convs.filter((c) => !c.shortTitle && !c.topic);
  const uuids = [...new Set(needsName.map((c) => mriUuid(c.id)).filter(Boolean))];
  const names = uuids.length ? await page.evaluate((u) => window.__tx.resolveNames(u), uuids) : {};
  return convs.map((c) => ({ ...c, label: labelFor(c, names) }));
}

/** Teams fills its IndexedDB a few seconds after the SPA boots. */
async function waitForConversations(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const convs = await page.evaluate(() => window.__tx.listConversations());
    // Settle: the list is still filling while the count keeps climbing.
    if (convs.length && convs.length === last) return convs;
    if (convs.length !== last) log(`   대화 동기화 중… ${convs.length}개`);
    last = convs.length;
    await page.waitForTimeout(3000);
  }
  if (last === 0) {
    throw new Error(
      'Teams 로컬 대화 목록이 비어 있습니다. --headed 로 실행해 Teams 가 완전히 뜰 때까지 기다려 보세요.',
    );
  }
  return page.evaluate(() => window.__tx.listConversations());
}

// ── commands ───────────────────────────────────────────────────────────
function cmdSetup() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const pkg = join(DATA_DIR, 'package.json');
  if (!existsSync(pkg)) {
    writeFileSync(pkg, JSON.stringify({ name: 'teams-export-data', private: true, type: 'module' }, null, 2));
  }
  console.log(`데이터 디렉터리: ${DATA_DIR}`);

  const vendored = join(DATA_DIR, 'node_modules', 'playwright-core');
  if (existsSync(vendored)) {
    console.log('playwright-core: 이미 설치됨');
  } else {
    console.log('playwright-core 설치 중…');
    // Browsers are NOT downloaded: we drive the system Chrome via channel:'chrome'.
    execFileSync('npm', ['install', 'playwright-core', '--no-audit', '--no-fund'],
      { cwd: DATA_DIR, stdio: 'inherit' });
  }

  const chromeMac = '/Applications/Google Chrome.app';
  const hasChrome = existsSync(chromeMac) || process.platform !== 'darwin';
  console.log(hasChrome
    ? 'Chrome: 확인됨 (시스템 Chrome 을 사용합니다)'
    : '⚠️  Chrome 이 없습니다. Google Chrome 을 먼저 설치하세요.');

  console.log('\n✅ 준비 완료. 다음:');
  console.log(`   node ${join(HERE, 'teams-export.mjs')} login`);
}

async function cmdLogin() {
  log('Chrome 창이 열립니다. 회사 계정으로 로그인하세요 (MFA 포함).');
  log('로그인이 끝나 Teams 가 뜨면 자동으로 감지하고 창을 닫습니다.\n');
  const { ctx, page } = await open({ headless: false });
  try {
    await page.goto(TEAMS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      if (await tokensReady(page)) {
        await page.waitForTimeout(4000); // let MSAL finish flushing its cache
        log('\n✅ 로그인 완료. 세션이 저장됐습니다.');
        log('   이제 `node teams-export.mjs list` 를 실행하세요.');
        return;
      }
      await page.waitForTimeout(2000);
    }
    throw new Error('시간 초과 (15분). 다시 시도하세요.');
  } finally {
    await ctx.close();
  }
}

async function cmdList() {
  const convs = await withTeams(async (page) => {
    const cfg = await page.evaluate(() => window.__tx.getConfig());
    log(`   region=${cfg.userRegion || '?'}  chatsvc=${new URL(cfg.chatServiceUrl).host}`);
    return enrich(page, await waitForConversations(page));
  });
  convs.sort((a, b) => Date.parse(b.lastMessageAt || 0) - Date.parse(a.lastMessageAt || 0));
  writeFileSync(CONV_CACHE, JSON.stringify(convs, null, 2));
  console.log(`\n대화 ${convs.length}개  (번호로 export 가능)\n`);
  convs.forEach((c, i) => {
    const when = c.lastMessageAt ? new Date(c.lastMessageAt).toISOString().slice(0, 16).replace('T', ' ') : '—';
    console.log(`${String(i + 1).padStart(3)}. ${when}  ${c.kind || 'Chat'}  ${c.label}`);
  });
  console.log(`\n목록 저장: ${CONV_CACHE}`);
  console.log('예) node teams-export.mjs export 3 --since 2026-07-01');
}

// ── corpus on disk ─────────────────────────────────────────────────────
// One file per conversation, named from a hash of the conversation id so the
// name is stable across runs even when the label or sidebar order changes.
const fileFor = (outDir, c) =>
  join(outDir, `${slug(c.label)}__${createHash('sha1').update(c.id).digest('hex').slice(0, 8)}.json`);

const readState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {});
const writeState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

const readCorpus = (outDir) => {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(readFileSync(join(outDir, f), 'utf8')); } catch { return null; }
    })
    .filter((c) => c && Array.isArray(c.messages));
};

/** Merge new messages into an existing file, de-duplicating by message id. */
function mergeInto(file, incoming) {
  if (!existsSync(file)) return incoming;
  let prev;
  try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch { return incoming; }
  const byId = new Map();
  for (const m of [...(prev.messages || []), ...incoming]) {
    byId.set(m.id || `${m.time}|${m.from}|${(m.text || '').slice(0, 40)}`, m);
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.time || 0) - Date.parse(b.time || 0));
}

async function cmdExport() {
  const outDir = resolve(opt('out', DEFAULT_OUT));
  const since = opt('since');
  const wantAll = flag('all');
  const full = flag('full');
  const target = positional[0];
  if (!wantAll && !target) throw new Error('대상이 없습니다. `export <번호|대화ID>` 또는 `export --all`');
  if (since && Number.isNaN(Date.parse(since))) throw new Error(`--since 날짜 형식 오류: ${since}`);

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const shapeOpts = { includeSystem: flag('include-system'), raw: flag('raw') };
  const state = readState();

  const written = await withTeams(async (page) => {
    const cfg = await page.evaluate(() => window.__tx.getConfig());
    const convs = await enrich(page, await waitForConversations(page));
    convs.sort((a, b) => Date.parse(b.lastMessageAt || 0) - Date.parse(a.lastMessageAt || 0));

    let picked;
    if (wantAll) picked = convs;
    else if (/^\d+$/.test(target)) {
      const idx = Number(target) - 1;
      if (!convs[idx]) throw new Error(`${target}번 대화가 없습니다 (총 ${convs.length}개). \`list\` 로 확인하세요.`);
      picked = [convs[idx]];
    } else {
      const exact = convs.find((c) => c.id === target);
      picked = exact ? [exact] : convs.filter((c) => c.label.toLowerCase().includes(target.toLowerCase()));
      if (!picked.length) throw new Error(`대화를 찾을 수 없습니다: ${target}`);
    }

    const results = [];
    let skipped = 0;
    for (const [i, c] of picked.entries()) {
      const prior = state[c.id];
      // Nothing new since last run — no network at all. This is what makes a
      // repeat `--all` cheap once the first full pull is done.
      if (!full && !since && prior?.lastMessageAt && c.lastMessageAt
          && Date.parse(c.lastMessageAt) <= Date.parse(prior.lastMessageAt)) {
        skipped++;
        continue;
      }
      // Incremental: only ask for messages newer than what we already have.
      const fetchSince = since || (full ? null : prior?.lastMessageAt || null);
      log(`[${i + 1}/${picked.length}] ${c.label}${fetchSince ? ` (${fetchSince.slice(0, 10)} 이후)` : ''} …`);
      let msgs;
      try {
        msgs = await page.evaluate(
          ([cf, id, s]) => window.__tx.fetchAllMessages(cf, id, s),
          [cfg, c.id, fetchSince],
        );
      } catch (err) {
        log(`   ⚠️  건너뜀 — ${err.message}`);
        continue;
      }
      const file = fileFor(outDir, c);
      const merged = full || since ? shape(msgs, shapeOpts) : mergeInto(file, shape(msgs, shapeOpts));
      writeFileSync(file, JSON.stringify({
        conversationId: c.id,
        label: c.label,
        kind: c.kind,
        exportedAt: new Date().toISOString(),
        messageCount: merged.length,
        messages: merged,
      }, null, 2));
      const newest = merged.length ? merged[merged.length - 1].time : c.lastMessageAt;
      state[c.id] = { label: c.label, file, lastMessageAt: newest, exportedAt: new Date().toISOString() };
      log(`   +${msgs.length}건 (총 ${merged.length}건)`);
      results.push({ label: c.label, added: msgs.length, total: merged.length });
    }
    if (skipped) log(`\n   변경 없어 건너뜀: ${skipped}개`);
    return results;
  });

  writeState(state);
  const added = written.reduce((n, r) => n + r.added, 0);
  console.log(`\n✅ 갱신 ${written.length}개 / 신규 ${added}건 → ${outDir}`);
  if (written.length) console.log('   이제 `find` 로 검색하거나, 저에게 바로 물어보세요.');
}

// ── sending ────────────────────────────────────────────────────────────
//
// Any conversation is a valid target: the point of this command is that the
// user can say "send X to Y" in Claude Code and have it happen. The one guard
// that stays is `--yes` — without it the command only previews, so a mistyped
// or half-formed invocation can never put a message in front of colleagues.
// Sending is effectively irreversible (recipients are notified even if the
// message is deleted afterwards).

/** True for the user's notes thread or a 1:1 whose every party is self. */
function isSelfChat(convId, selfUuid) {
  if (convId === '48:notes') return true;
  if (!selfUuid) return false;
  const found = [...String(convId).matchAll(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi)]
    .map((m) => m[0].toLowerCase());
  return found.length > 0 && found.every((u) => u === String(selfUuid).toLowerCase());
}

async function cmdSend() {
  const target = positional[0];
  const text = positional.slice(1).join(' ');
  if (!target || !text) {
    throw new Error('사용법: send <번호|대화ID|self> "보낼 내용" [--yes]');
  }

  await withTeams(async (page) => {
    const cfg = await page.evaluate(() => window.__tx.getConfig());
    const convs = await enrich(page, await waitForConversations(page));
    convs.sort((a, b) => Date.parse(b.lastMessageAt || 0) - Date.parse(a.lastMessageAt || 0));

    let conv;
    if (target === 'self') {
      conv = convs.find((c) => c.id === '48:notes') || convs.find((c) => isSelfChat(c.id, cfg.selfUuid));
      if (!conv) throw new Error('본인 채팅방을 찾지 못했습니다.');
    } else if (/^\d+$/.test(target)) {
      conv = convs[Number(target) - 1];
      if (!conv) throw new Error(`${target}번 대화가 없습니다. \`list\` 로 확인하세요.`);
    } else {
      conv = convs.find((c) => c.id === target)
        || convs.find((c) => c.label.toLowerCase().includes(target.toLowerCase()));
      if (!conv) throw new Error(`대화를 찾을 수 없습니다: ${target}`);
    }

    const self = isSelfChat(conv.id, cfg.selfUuid);
    console.log(`대상 : ${conv.label}  (${conv.id})${self ? '  [본인 채팅방]' : '  ⚠️ 다른 참여자가 있는 방'}`);
    console.log(`내용 : ${text}`);
    if (!flag('yes')) {
      console.log('\n미리보기만 했습니다. 실제로 보내려면 --yes 를 붙이세요.');
      return;
    }
    const res = await page.evaluate(
      ([cf, id, t, plain]) => window.__tx.sendMessage(cf, id, t, { plain }),
      [cfg, conv.id, text, flag('plain')],
    );
    console.log(`\n✅ 전송됨 (HTTP ${res.status}, 발신자="${res.imdisplayname || '(미확인)'}", clientmessageid=${res.clientmessageid})`);
  });
}

// ── querying the corpus ────────────────────────────────────────────────
const fmt = (m, room) =>
  `[${room}] ${(m.time || '').slice(0, 16).replace('T', ' ')} ${m.from || '?'}\n  ${(m.text || '').replace(/\n/g, '\n  ')}`;

function cmdFind() {
  const outDir = resolve(opt('out', DEFAULT_OUT));
  const q = positional[0];
  if (!q) throw new Error('검색어가 없습니다. `find <검색어> [--room 패턴] [--from 이름] [--since 날짜]`');
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const room = opt('room');
  const from = opt('from');
  const since = opt('since') ? Date.parse(opt('since')) : null;
  const until = opt('until') ? Date.parse(opt('until')) : null;
  const ctxN = Number(opt('context', '0')) || 0;
  const limit = Number(opt('limit', '80')) || 80;

  const hits = [];
  for (const conv of readCorpus(outDir)) {
    if (room && !conv.label.toLowerCase().includes(room.toLowerCase())) continue;
    conv.messages.forEach((m, idx) => {
      const t = Date.parse(m.time || 0);
      if (since && t < since) return;
      if (until && t > until) return;
      if (from && !(m.from || '').toLowerCase().includes(from.toLowerCase())) return;
      if (!rx.test(m.text || '')) return;
      const lo = Math.max(0, idx - ctxN);
      const hi = Math.min(conv.messages.length - 1, idx + ctxN);
      hits.push({ conv, idx, block: conv.messages.slice(lo, hi + 1) });
    });
  }
  hits.sort((a, b) => Date.parse(a.block[0].time || 0) - Date.parse(b.block[0].time || 0));

  if (!hits.length) { console.log('일치하는 메시지가 없습니다.'); return; }
  console.log(`${hits.length}건 일치${hits.length > limit ? ` (최근 ${limit}건만 표시)` : ''}\n`);
  for (const h of hits.slice(-limit)) {
    for (const m of h.block) console.log(fmt(m, h.conv.label));
    console.log('');
  }
}

function cmdRecent() {
  const outDir = resolve(opt('out', DEFAULT_OUT));
  const days = Number(opt('days', '3')) || 3;
  const perRoom = Number(opt('limit', '40')) || 40;
  const cutoff = Date.now() - days * 86400000;
  const rooms = [];
  for (const conv of readCorpus(outDir)) {
    const msgs = conv.messages.filter((m) => Date.parse(m.time || 0) >= cutoff);
    if (msgs.length) rooms.push({ label: conv.label, msgs });
  }
  rooms.sort((a, b) =>
    Date.parse(b.msgs[b.msgs.length - 1].time || 0) - Date.parse(a.msgs[a.msgs.length - 1].time || 0));
  if (!rooms.length) { console.log(`최근 ${days}일 내 메시지가 없습니다.`); return; }
  console.log(`최근 ${days}일 — 방 ${rooms.length}개 / 메시지 ${rooms.reduce((n, r) => n + r.msgs.length, 0)}건\n`);
  for (const r of rooms) {
    console.log(`\n=== ${r.label} (${r.msgs.length}건) ===`);
    const shown = r.msgs.slice(-perRoom);
    if (shown.length < r.msgs.length) console.log(`   … 앞부분 ${r.msgs.length - shown.length}건 생략`);
    for (const m of shown) {
      console.log(`${(m.time || '').slice(0, 16).replace('T', ' ')} ${m.from || '?'}: ${(m.text || '').replace(/\n/g, ' ⏎ ')}`);
    }
  }
}

function cmdStats() {
  const outDir = resolve(opt('out', DEFAULT_OUT));
  const corpus = readCorpus(outDir);
  const total = corpus.reduce((n, c) => n + c.messages.length, 0);
  const times = corpus.flatMap((c) => c.messages.map((m) => Date.parse(m.time || 0))).filter(Boolean);

  // Freshness first — the /teams skill keys its auto-refresh off this line.
  const state = readState();
  const stamps = Object.values(state).map((s) => Date.parse(s.exportedAt || 0)).filter(Boolean);
  if (stamps.length) {
    const last = Math.max(...stamps);
    const ageMin = Math.round((Date.now() - last) / 60000);
    const age = ageMin < 60 ? `${ageMin}분 전`
      : ageMin < 1440 ? `${Math.round(ageMin / 60)}시간 전`
      : `${Math.round(ageMin / 1440)}일 전`;
    console.log(`마지막 수집: ${new Date(last).toISOString().slice(0, 16).replace('T', ' ')} (${age})`);
  } else {
    console.log('마지막 수집: 없음 — `export --all` 을 먼저 실행하세요');
  }
  console.log(`대화 ${corpus.length}개 / 메시지 ${total}건`);
  if (times.length) {
    console.log(`기간: ${new Date(Math.min(...times)).toISOString().slice(0, 10)} ~ ${new Date(Math.max(...times)).toISOString().slice(0, 10)}`);
  }
  console.log('\n방별 메시지 수 (상위 20)');
  corpus.map((c) => ({ label: c.label, n: c.messages.length }))
    .sort((a, b) => b.n - a.n).slice(0, 20)
    .forEach((r) => console.log(`  ${String(r.n).padStart(6)}  ${r.label}`));
}

function cmdWipe() {
  for (const p of [PROFILE_DIR, CONV_CACHE]) {
    if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); console.log(`삭제: ${p}`); }
  }
  console.log('로그인 세션이 제거됐습니다. 내보낸 JSON(out/)은 그대로 있습니다.');
}

// ── entry ──────────────────────────────────────────────────────────────
const USAGE = `
teams-export — 본인 Teams 채팅을 JSON 으로 내려받고 검색합니다.

준비
  node teams-export.mjs setup                 최초 1회. 데이터 디렉터리 + 의존성 설치

수집
  node teams-export.mjs login                 최초 1회 로그인 (창이 열림)
  node teams-export.mjs list                  대화 목록 보기
  node teams-export.mjs export --all          전체 수집 (2회차부터는 증분)
  node teams-export.mjs export <번호|ID>      대화 하나만

조회 (수집된 데이터에서, 네트워크 없음)
  node teams-export.mjs recent --days 3       최근 며칠간 오간 대화
  node teams-export.mjs find "키워드"          전체 검색
  node teams-export.mjs stats                 수집 현황

발송
  node teams-export.mjs send <번호|ID|이름|self> "내용"        미리보기만
  node teams-export.mjs send <번호|ID|이름|self> "내용" --yes  실제 전송

관리
  node teams-export.mjs wipe                  로그인 세션 삭제

옵션
  export : --since 2026-07-01  --full(증분 무시 전체 재수집)  --raw
           --include-system  --out <dir>  --headed
  find   : --room <방이름>  --from <보낸사람>  --since / --until
           --context N(앞뒤 N개 같이)  --limit N
  recent : --days N  --limit N(방당 표시 개수)
`;
const commands = {
  setup: cmdSetup, login: cmdLogin, list: cmdList, export: cmdExport, send: cmdSend,
  find: cmdFind, recent: cmdRecent, stats: cmdStats, wipe: cmdWipe,
};
if (!commands[cmd]) {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
try {
  await commands[cmd]();
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}
