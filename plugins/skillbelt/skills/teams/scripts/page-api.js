/*
 * page-api.js — runs INSIDE the authenticated teams.microsoft.com page.
 *
 * Defines window.__tx with token discovery + chat-service calls. Nothing here
 * talks to any host other than Microsoft's own endpoints; the data never
 * leaves the machine (teams-export.mjs writes it straight to disk).
 *
 * The MSAL cache-decryption and chat-service call shapes are adapted from
 * gediz/teams-web-chat-exporter (MIT). MSAL Browser v4+ encrypts its
 * localStorage entries: the base key lives in the `msal.cache.encryption`
 * cookie, per-entry AES-GCM keys are derived with HKDF-SHA256 (salt = entry
 * nonce, info = clientId), and the IV is 12 zero bytes.
 */
(() => {
  const b64uToBytes = (b) => {
    const s = b.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  let cachedBaseKey = null;
  async function getMsalBaseKey() {
    const m = document.cookie.match(/msal\.cache\.encryption=([^;]+)/);
    if (!m) return null;
    let parsed;
    try { parsed = JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
    if (!parsed.key) return null;
    if (cachedBaseKey?.raw === parsed.key) return cachedBaseKey.key;
    try {
      const key = await crypto.subtle.importKey('raw', b64uToBytes(parsed.key), 'HKDF', false, ['deriveKey']);
      cachedBaseKey = { raw: parsed.key, key };
      return key;
    } catch { return null; }
  }

  // msal.2|<accountId>|<env>|accesstoken|<clientId>|<realm>|<target>|
  const encryptionContext = (lsKey) => {
    const p = lsKey.split('|');
    return p[3] === 'accesstoken' && p[4] ? p[4] : '';
  };

  async function decryptEntry(baseKey, entry, context) {
    if (!entry.nonce || !entry.data) return null;
    try {
      const derived = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: b64uToBytes(entry.nonce), info: new TextEncoder().encode(context) },
        baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
      );
      const out = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(12) }, derived, b64uToBytes(entry.data),
      );
      return JSON.parse(new TextDecoder().decode(out));
    } catch { return null; }
  }

  async function findValidToken(scopePattern) {
    const now = Math.floor(Date.now() / 1000);
    let baseKey = null;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.includes('accesstoken') || !key.includes(scopePattern)) continue;
      try {
        const entry = JSON.parse(localStorage.getItem(key) || '');
        if (entry.secret && Number(entry.expiresOn) > now) return entry.secret;
        if (entry.data && entry.nonce) {
          if (!baseKey) baseKey = await getMsalBaseKey();
          if (!baseKey) continue;
          const dec = await decryptEntry(baseKey, entry, encryptionContext(key));
          if (dec?.secret && Number(dec.expiresOn) > now) return dec.secret;
        }
      } catch { /* skip malformed */ }
    }
    return null;
  }

  const getIc3Token = async () =>
    (await findValidToken('ic3.teams.office.com'))
    || (await findValidToken('ic3.teams.office365.us'))
    || (await findValidToken('chatsvcagg'));

  const getSkypeToken = () => findValidToken('spaces.skype');
  const getGraphToken = async () =>
    (await findValidToken('graph.microsoft.com')) || (await findValidToken('graph.microsoft.us'));

  function getCurrentUserUuid() {
    const RE = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
    const scopes = ['ic3.teams.office.com', 'spaces.skype', 'graph.microsoft.com'];
    const scan = (pred) => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.includes('accesstoken') || !pred(k)) continue;
        const m = (k.split('|')[1] || '').match(RE);
        if (m) return m[1];
      }
      return null;
    };
    return scan((k) => scopes.some((s) => k.includes(s))) ?? scan(() => true);
  }

  const authzUrl = () =>
    location.hostname.toLowerCase().includes('teams.microsoft.us')
      ? 'https://authsvc.teams.microsoft.us/v1.0/authz'
      : 'https://authsvc.teams.microsoft.com/v1.0/authz';

  async function discover(skypeToken) {
    const resp = await fetch(authzUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${skypeToken}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`authz failed: ${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    const chatServiceUrl = data.regionGtms?.chatService;
    if (!chatServiceUrl) throw new Error('authz response missing chatService URL');
    return { chatServiceUrl, userRegion: data.userRegion || data.region || '' };
  }

  /** Everything the chat-service calls need. Tokens are re-read per page. */
  async function getConfig() {
    const skype = await getSkypeToken();
    if (!skype) throw new Error('no Skype token in MSAL cache — not signed in yet?');
    const ic3 = await getIc3Token();
    if (!ic3) throw new Error('no IC3 token in MSAL cache — not signed in yet?');
    const { chatServiceUrl, userRegion } = await discover(skype);
    return { chatServiceUrl, userRegion, selfUuid: getCurrentUserUuid() };
  }

  const VIEW = 'msnp24Equivalent%7CsupportsMessageProperties';
  const NON_EXPORTABLE_PREFIX = ['StreamOf', 'Activity', 'Notification'];
  const NON_EXPORTABLE_EXACT = new Set(['Saved', 'Drafts', 'CallLog', 'CallLogs', 'Mentions']);

  const exportable = (ptt) => {
    if (!ptt) return true;
    if (NON_EXPORTABLE_EXACT.has(ptt)) return false;
    return !NON_EXPORTABLE_PREFIX.some((p) => ptt.startsWith(p));
  };

  /** GET with the IC3 bearer, retrying 429/5xx with backoff. */
  async function apiGet(url, maxRetries = 5) {
    let delay = 1000;
    for (let attempt = 0; ; attempt++) {
      const token = await getIc3Token();
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });
      if (resp.ok) return resp.json();
      const retryable = resp.status === 429 || resp.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`GET ${resp.status} ${resp.statusText} — ${url.slice(0, 120)}`);
      }
      const ra = Number(resp.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay));
      delay = Math.min(delay * 2, 16000);
    }
  }

  // ── Conversation list, from Teams' own IndexedDB ─────────────────────
  //
  // The chat service's /v1/users/ME/conversations endpoint 401s for a plain
  // IC3 bearer, so we read the list Teams already keeps locally instead. It
  // is also more complete than the API (meeting-derived chats and other niche
  // product types show up) and matches the sidebar exactly.

  /** Teams DB names embed tenant/user/locale; several may exist per prefix. */
  async function findTeamsDbs(prefix) {
    if (typeof indexedDB.databases !== 'function') return [];
    try {
      const all = await indexedDB.databases();
      return all
        .filter((d) => d.name && d.name.startsWith(`Teams:${prefix}:`))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  }

  const openDbRO = (name) => new Promise((resolve) => {
    try {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });

  const readAll = (db, storeName) => new Promise((resolve) => {
    try {
      if (!db.objectStoreNames.contains(storeName)) { resolve([]); return; }
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });

  // ── sending ──────────────────────────────────────────────────────────
  // Writes go to the same chat-service conversation resource that messages are
  // read from. Guarded on the Node side (self-chat only) — see cmdSend.

  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // The chat service does not stamp a display name onto messages it accepts —
  // the sender is identified by the token, and `imdisplayname` is whatever the
  // client puts there. Without it the message reads back with an empty author.
  let cachedSelfName;
  async function getSelfName() {
    if (cachedSelfName !== undefined) return cachedSelfName;
    const uuid = getCurrentUserUuid();
    if (!uuid) return (cachedSelfName = '');
    const names = await resolveNames([uuid]);
    return (cachedSelfName = names[uuid] || '');
  }

  async function sendMessage(cfg, conversationId, text, { plain = false } = {}) {
    const token = await getIc3Token();
    if (!token) throw new Error('no IC3 token');
    // Teams' own client sends a numeric client-side id for dedupe/echo matching.
    const clientmessageid = String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    const imdisplayname = await getSelfName();
    const body = plain
      ? { content: text, messagetype: 'Text', contenttype: 'text', clientmessageid }
      : {
        content: escapeHtml(text).replace(/\n/g, '<br>'),
        messagetype: 'RichText/Html',
        contenttype: 'text',
        clientmessageid,
      };
    if (imdisplayname) body.imdisplayname = imdisplayname;
    const url = `${cfg.chatServiceUrl}/v1/users/ME/conversations/${encodeURIComponent(conversationId)}/messages`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const raw = await resp.text();
    if (!resp.ok) throw new Error(`POST ${resp.status} ${resp.statusText} — ${raw.slice(0, 300)}`);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* some responses are empty */ }
    return { status: resp.status, clientmessageid, imdisplayname, response: parsed };
  }

  async function listConversations() {
    const dbs = await findTeamsDbs('conversation-manager');
    const merged = new Map();
    for (const meta of dbs) {
      const db = await openDbRO(meta.name);
      if (!db) continue;
      try {
        for (const r of await readAll(db, 'conversations')) {
          if (!r?.id) continue;
          const prev = merged.get(r.id);
          // Locale DBs run in parallel and drift; keep the freshest row.
          if (!prev || (r.lastMessageTimeUtc || 0) > (prev.lastMessageTimeUtc || 0)) merged.set(r.id, r);
        }
      } finally { try { db.close(); } catch { /* ignore */ } }
    }

    const out = [];
    for (const r of merged.values()) {
      const tp = r.threadProperties || {};
      if (!/^(19:|48:)/.test(r.id)) continue;            // real threads + self-chat only
      if (!exportable(tp.threadType) || !exportable(tp.productContext)) continue;
      const iso = r.lastMessage?.originalarrivaltime || r.lastMessage?.composetime
        || (r.lastMessageTimeUtc ? new Date(r.lastMessageTimeUtc).toISOString() : null);
      out.push({
        id: r.id,
        topic: tp.topic || null,
        shortTitle: r.chatTitle?.shortTitle || null,
        kind: tp.threadType || r.type || null,
        groupId: tp.groupId || null,
        hidden: tp.hidden === true,
        lastMessageAt: iso,
        lastMessageFrom: r.lastMessage?.imdisplayname || null,
      });
    }
    return out;
  }

  async function fetchAllMessages(cfg, conversationId, sinceISO, maxPages = 500) {
    const sinceMs = sinceISO ? Date.parse(sinceISO) : NaN;
    const all = [];
    let url = `${cfg.chatServiceUrl}/v1/users/ME/conversations/${encodeURIComponent(conversationId)}`
      + `/messages?pageSize=200&startTime=1&view=${VIEW}`;
    let delay = 150;
    for (let page = 0; url && page < maxPages; page++) {
      const data = await apiGet(url);
      if (data.errorCode) throw new Error(`messages API error ${data.errorCode}: ${data.message}`);
      const msgs = data.messages || [];
      if (!msgs.length && !data._metadata?.backwardLink) break;
      all.push(...msgs);
      window.__txProgress = { conversationId, page: page + 1, count: all.length };
      // Pagination walks newest -> oldest, so one out-of-range page ends it.
      if (Number.isFinite(sinceMs) && msgs.some((m) => {
        const ts = Date.parse(m.composetime || m.originalarrivaltime || '');
        return Number.isFinite(ts) && ts < sinceMs;
      })) break;
      url = data._metadata?.backwardLink || null;
      if (url) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay + 50, 600);
      }
    }
    if (Number.isFinite(sinceMs)) {
      return all.filter((m) => {
        const ts = Date.parse(m.composetime || m.originalarrivaltime || '');
        return !Number.isFinite(ts) || ts >= sinceMs;
      });
    }
    return all;
  }

  /** Best-effort display names for MRIs, via one Graph $batch. Never throws. */
  async function resolveNames(uuids) {
    const names = {};
    try {
      const token = await getGraphToken();
      if (!token) return names;
      for (let i = 0; i < uuids.length; i += 20) {
        const chunk = uuids.slice(i, i + 20);
        const resp = await fetch('https://graph.microsoft.com/v1.0/$batch', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: chunk.map((u, idx) => ({
              id: String(idx), method: 'GET', url: `/users/${u}?$select=displayName`,
            })),
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        for (const r of data.responses || []) {
          if (r.status === 200 && r.body?.displayName) names[chunk[Number(r.id)]] = r.body.displayName;
        }
      }
    } catch { /* names are a nicety, not a requirement */ }
    return names;
  }

  window.__tx = {
    getIc3Token, getSkypeToken, getConfig, getCurrentUserUuid,
    listConversations, fetchAllMessages, resolveNames, sendMessage,
    ready: async () => Boolean(await getIc3Token()),
    /** Teams populates its IDB a few seconds after the SPA boots. */
    convCount: async () => (await listConversations()).length,
  };
})();
