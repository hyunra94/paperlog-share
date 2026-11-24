/* =========================================================
   Paper Log Share Worker
   - PaperLog의 일부('공유 안 함'에 체크하지 않은 일정, 공개한 카테고리의 지출)만
     여러 사람과 함께 보고 쓰는 공유 앱용 Worker.
   - PaperLog 본 Worker의 SECRET_KEY는 쓰지 않는다. 같은 NOTION_TOKEN을 쓰지만
     이 Worker의 API는 공개 범위 밖의 데이터를 읽거나 쓰지 않는다.
   - 설정(공개 범위, 멤버)과 로그인 세션은 SHARE_KV에 저장한다.

   권한
   - ADMIN_KEY로 로그인한 사람 = 관리자(앱 주인). 모든 공유 항목을 수정/삭제, 설정 변경.
   - 멤버(이름 + 개인 코드): 누구의 것으로든 추가 가능(대신 추가),
     수정/삭제는 담당자 본인 또는 그 항목을 입력한 사람만.
   - 담당자가 비어 있는 기존 항목(PaperLog에서 입력한 것)은 관리자 것으로 본다.
========================================================= */

const NOTION_VERSION = "2025-09-03";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30일
const CONFIG_KEY = "config";
const RANGE_LOOKBACK_DAYS = 60;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (!env.SHARE_KV) throw httpError(500, "SHARE_KV가 연결되지 않았어요.");
      if (path === "/api/login" && method === "POST") return json(await login(request, env), 200, cors);

      // 서버끼리 호출: 일과기록 알림 서버가 아침 브리핑용으로 그날 공유 일정을 받아 간다.
      if (path === "/api/briefing" && method === "GET") {
        const secret = request.headers.get("x-briefing-secret") || "";
        if (!env.BRIEFING_SECRET || !safeEqual(secret, env.BRIEFING_SECRET)) return json({ ok: false, error: "Forbidden" }, 403, cors);
        return json({ ok: true, ...(await briefing(env, url.searchParams.get("date"))) }, 200, cors);
      }
      if (path === "/api/push/key" && method === "GET") return json({ ok: true, key: env.VAPID_PUBLIC || "" }, 200, cors);

      const session = await getSession(request, env);
      if (!session) return json({ ok: false, error: "로그인이 필요해요." }, 401, cors);

      if (path === "/api/logout" && method === "POST") {
        await env.SHARE_KV.delete(`session:${tokenOf(request)}`);
        return json({ ok: true }, 200, cors);
      }

      if (path === "/api/me" && method === "GET") {
        const config = await getConfig(env);
        return json({ ok: true, me: publicMe(session), ...publicConfig(config) }, 200, cors);
      }

      if (path === "/api/schedules" && method === "GET") return json({ ok: true, schedules: await listSchedules(url, env, session) }, 200, cors);
      if (path === "/api/schedules" && method === "POST") return json({ ok: true, item: await createSchedule(request, env, session) }, 200, cors);
      if (path === "/api/schedules" && method === "PATCH") return json({ ok: true, item: await updateSchedule(request, env, session) }, 200, cors);
      if (path === "/api/schedules" && method === "DELETE") return json({ ok: true, ...(await deleteSchedule(request, env, session)) }, 200, cors);

      // 아침 알림: 이 기기를 등록/해제, 시험 발송
      if (path === "/api/push/subscribe" && method === "POST") return json({ ok: true, ...(await pushSubscribe(request, env, session)) }, 200, cors);
      if (path === "/api/push/subscribe" && method === "DELETE") return json({ ok: true, ...(await pushUnsubscribe(request, env)) }, 200, cors);
      if (path === "/api/push/test" && method === "POST") return json({ ok: true, ...(await pushTest(request, env, session)) }, 200, cors);

      if (path === "/api/expenses" && method === "GET") return json({ ok: true, ...(await listExpenses(url, env)) }, 200, cors);
      if (path === "/api/expenses" && method === "POST") return json({ ok: true, item: await createExpense(request, env, session) }, 200, cors);
      if (path === "/api/expenses" && method === "PATCH") return json({ ok: true, item: await updateExpense(request, env, session) }, 200, cors);
      if (path === "/api/expenses" && method === "DELETE") return json({ ok: true, ...(await deleteExpense(request, env, session)) }, 200, cors);

      // ---- 관리자 전용 ----
      if (path.startsWith("/api/admin/")) {
        if (!session.admin) return json({ ok: false, error: "관리자만 할 수 있어요." }, 403, cors);
        if (path === "/api/admin/options" && method === "GET") return json({ ok: true, ...(await adminOptions(env)) }, 200, cors);
        if (path === "/api/admin/config" && method === "GET") return json({ ok: true, config: adminView(await getConfig(env)) }, 200, cors);
        if (path === "/api/admin/config" && method === "PUT") return json({ ok: true, config: adminView(await saveAdminConfig(request, env)) }, 200, cors);
        if (path === "/api/admin/setup-notion" && method === "POST") return json({ ok: true, ...(await setupNotionProps(env)) }, 200, cors);
      }

      return json({ ok: false, error: "Not found", path }, 404, cors);
    } catch (err) {
      const status = err.status || 500;
      return json({ ok: false, error: err.message || "Worker error" }, status, cors);
    }
  },

  // 매일 08:00 KST (crons = "0 23 * * *" UTC): 이 앱에서 알림을 켠 기기에 오늘 공유 일정 브리핑
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendMorningBriefing(env));
  },
};

/* ---------------- 공통 ---------------- */

function corsHeaders(request, env) {
  const allowed = String(env.CORS_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : allowed[0] || "");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-share-token,x-sini-token,x-briefing-secret",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function props(env) {
  return {
    schedule: {
      title: env.SCHEDULE_TITLE_PROP || "제목",
      date: env.SCHEDULE_DATE_PROP || "날짜",
      category: env.SCHEDULE_CATEGORY_PROP || "카테고리",
      cancel: env.SCHEDULE_CANCEL_PROP || "취소",
      project: env.SCHEDULE_PROJECT_PROP || "프로젝트",
    },
    expense: {
      title: env.EXPENSE_TITLE_PROP || "Information",
      date: env.EXPENSE_DATE_PROP || "날짜",
      amount: env.EXPENSE_AMOUNT_PROP || "amount",
      subject: env.EXPENSE_SUBJECT_PROP || "Subject",
      done: env.EXPENSE_DONE_PROP || "입력완료",
    },
    project: {
      title: env.PROJECT_TITLE_PROP || "프로젝트 이름",
      status: env.PROJECT_STATUS_PROP || "상태",
    },
    owner: env.SHARE_OWNER_PROP || "공유 담당자",
    author: env.SHARE_AUTHOR_PROP || "공유 작성자",
    memo: env.SHARE_MEMO_PROP || "공유 메모",   // 일정 DB: 하자·AS 상황 등 함께 보는 메모 (텍스트)
    kind: env.SHARE_KIND_PROP || "공유 분류",   // 일정 DB: 일정 / 하자·AS (선택)
    hide: env.SHARE_HIDE_PROP || "공유 안 함",  // 일정 DB: 체크하면 공유 앱에 안 보임 (체크박스)
  };
}

// 가계부 공유 범위 기본값: '공유' 카테고리
function scopeName(env) { return env.SHARE_SCOPE_NAME || "공유"; }
const KINDS = ["일정", "하자·AS"];
const MEMO_MAX = 2000;

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

function clean(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v || ""); }
function isTime(v) { return /^\d{2}:\d{2}$/.test(v || ""); }

/* ---------------- 설정 / 세션 ---------------- */

async function getConfig(env) {
  const raw = await env.SHARE_KV.get(CONFIG_KEY, "json");
  return {
    appName: "같이 쓰는 Paper Log",
    ownerName: "관리자",
    categories: [scopeName(env)], // 기본: '공유' 카테고리만
    defaultScheduleCategory: "",
    hiddenProjects: [],           // 이 프로젝트에 연결된 일정은 체크 없이도 공유 안 함 (프로젝트 페이지 id, 대시 없이)
    members: [],                  // [{ name, salt, hash }]
    ...(raw || {}),
  };
}

function publicConfig(config) {
  return {
    appName: config.appName,
    ownerName: config.ownerName,
    categories: config.categories,
    people: [config.ownerName, ...config.members.map(m => m.name)],
  };
}

function adminView(config) {
  return { ...config, members: config.members.map(m => ({ name: m.name, hasCode: Boolean(m.hash), siniId: m.siniId || "", scheduleCategory: m.scheduleCategory || "" })) };
}

function cleanSiniId(v) {
  return clean(v, 60).toLowerCase().replace(/@.*$/, "");
}

function publicMe(session) {
  return { name: session.name, admin: Boolean(session.admin) };
}

function tokenOf(request) {
  return request.headers.get("x-share-token") || "";
}

// 일과기록(sini) 앱에서 온 요청: 그 앱의 Supabase 로그인 토큰을 Supabase에 확인하고,
// 관리자 설정에서 그 아이디와 연결한 멤버로 인정한다. (관리자 권한은 절대 주지 않음)
async function siniSession(siniToken, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) throw httpError(503, "일과기록 연결이 설정되지 않았어요.");
  if (siniToken.length < 20 || siniToken.length > 4096) return null;
  const cacheKey = `sini:${await sha256Hex(siniToken)}`;
  let email = await env.SHARE_KV.get(cacheKey);
  if (!email) {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${siniToken}` },
    });
    if (!res.ok) return null; // 만료·위조 토큰
    const user = await res.json().catch(() => ({}));
    email = String(user.email || "").toLowerCase();
    if (!email) return null;
    await env.SHARE_KV.put(cacheKey, email, { expirationTtl: 300 }); // 5분 동안 다시 묻지 않음
  }
  const domain = (env.SINI_ID_DOMAIN || "@sini.hyunra.kr").toLowerCase();
  if (!email.endsWith(domain)) return null;
  const siniId = email.slice(0, -domain.length);
  const config = await getConfig(env);
  const member = config.members.find(m => m.siniId && m.siniId === siniId);
  if (!member) throw httpError(403, "아직 공유 앱과 연결되지 않은 계정이에요. 관리자에게 일과기록 아이디 연결을 부탁하세요.");
  return { name: member.name, admin: false, via: "sini" };
}

async function getSession(request, env) {
  const token = tokenOf(request);
  const siniToken = request.headers.get("x-sini-token") || "";
  if (!token && siniToken) return siniSession(siniToken, env);
  if (!token || token.length < 20) return null;
  const session = await env.SHARE_KV.get(`session:${token}`, "json");
  if (!session) return null;
  const config = await getConfig(env);
  if (session.admin) {
    session.name = config.ownerName; // 관리자 이름을 바꿔도 바로 반영
  } else if (!config.members.some(m => m.name === session.name)) {
    return null; // 멤버에서 빠진 사람은 바로 로그아웃
  }
  return session;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 24) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function login(request, env) {
  const body = await readBody(request);
  const name = clean(body.name, 40);
  const code = String(body.code || "");
  if (!code) throw httpError(400, "코드를 입력해 주세요.");

  // 로그인 시도 제한: 같은 IP에서 10분에 20회
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateKey = `rate:${ip}`;
  const tries = Number(await env.SHARE_KV.get(rateKey) || 0);
  if (tries >= 20) throw httpError(429, "시도가 너무 많아요. 잠시 후 다시 해 주세요.");

  const config = await getConfig(env);
  let session = null;

  if (env.ADMIN_KEY && safeEqual(code, env.ADMIN_KEY)) {
    session = { name: config.ownerName, admin: true };
  } else {
    const member = config.members.find(m => m.name === name);
    if (member && member.hash && safeEqual(await sha256Hex(`${member.salt}:${code}`), member.hash)) {
      session = { name: member.name, admin: false };
    }
  }

  if (!session) {
    await env.SHARE_KV.put(rateKey, String(tries + 1), { expirationTtl: 600 });
    throw httpError(401, "이름이나 코드가 맞지 않아요.");
  }

  const token = randomHex(24);
  await env.SHARE_KV.put(`session:${token}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });
  return { ok: true, token, me: publicMe(session), ...publicConfig(config) };
}

async function saveAdminConfig(request, env) {
  const body = await readBody(request);
  const config = await getConfig(env);

  if (body.appName !== undefined) config.appName = clean(body.appName, 40) || config.appName;
  if (body.ownerName !== undefined) config.ownerName = clean(body.ownerName, 40) || config.ownerName;
  if (body.defaultScheduleCategory !== undefined) config.defaultScheduleCategory = clean(body.defaultScheduleCategory, 40);

  if (Array.isArray(body.hiddenProjects)) {
    config.hiddenProjects = [...new Set(body.hiddenProjects.map(id => normId(clean(id, 64))).filter(id => /^[0-9a-f]{32}$/.test(id)))];
  }

  if (Array.isArray(body.categories)) {
    config.categories = [...new Set(body.categories.map(c => clean(c, 60)).filter(Boolean))];
  }

  // members: [{ name, code?, siniId? }] — code가 있으면 새로 설정, 없으면 기존 코드 유지
  // siniId: 일과기록 앱 아이디. 연결하면 그 앱에서 따로 코드 없이 이 멤버로 들어온다.
  if (Array.isArray(body.members)) {
    const old = new Map(config.members.map(m => [m.name, m]));
    const next = [];
    const seen = new Set([config.ownerName]);
    const seenSini = new Set();
    for (const m of body.members) {
      const name = clean(m?.name, 40);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const prev = old.get(name) || {};
      const siniId = m.siniId !== undefined ? cleanSiniId(m.siniId) : (prev.siniId || "");
      if (siniId) {
        if (!/^[a-z0-9._-]{2,40}$/.test(siniId)) throw httpError(400, `${name}님의 일과기록 아이디를 확인해 주세요.`);
        if (seenSini.has(siniId)) throw httpError(400, `일과기록 아이디 '${siniId}'가 두 사람에게 연결돼 있어요.`);
        seenSini.add(siniId);
      }
      const code = String(m.code || "");
      let entry;
      if (code) {
        if (code.length < 4) throw httpError(400, `${name}님의 코드는 4자 이상이어야 해요.`);
        const salt = randomHex(8);
        entry = { name, salt, hash: await sha256Hex(`${salt}:${code}`) };
      } else if (prev.hash) {
        entry = { name, salt: prev.salt, hash: prev.hash };
      } else if (siniId) {
        entry = { name }; // 일과기록으로만 들어오는 사람
      } else {
        throw httpError(400, `${name}님의 코드를 정하거나 일과기록 아이디를 연결해 주세요.`);
      }
      if (siniId) entry.siniId = siniId;
      const scheduleCategory = m.scheduleCategory !== undefined ? clean(m.scheduleCategory, 60) : (prev.scheduleCategory || "");
      if (scheduleCategory) entry.scheduleCategory = scheduleCategory;
      next.push(entry);
    }
    config.members = next;
  }

  await env.SHARE_KV.put(CONFIG_KEY, JSON.stringify(config));
  return config;
}

/* ---------------- Notion ---------------- */

async function notion(env, path, method = "GET", body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw httpError(502, `Notion 오류 ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function notionQueryAll(env, dataSourceId, body = {}) {
  const results = [];
  let cursor;
  do {
    const data = await notion(env, `/data_sources/${dataSourceId}/query`, "POST", {
      page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}),
    });
    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function readTitle(p) {
  for (const v of Object.values(p || {})) if (v?.type === "title") return v.title.map(t => t.plain_text).join("").trim();
  return "";
}
function readText(p, name) {
  const v = p?.[name];
  if (!v) return "";
  if (v.type === "rich_text") return v.rich_text.map(t => t.plain_text).join("").trim();
  if (v.type === "select") return v.select?.name || "";
  if (v.type === "multi_select") return (v.multi_select || []).map(x => x.name).join(", ");
  if (v.type === "status") return v.status?.name || "";
  return "";
}
function readNumber(p, name) {
  const v = p?.[name];
  if (v?.type === "number") return Number(v.number || 0);
  if (v?.type === "formula" && v.formula?.type === "number") return Number(v.formula.number || 0);
  return 0;
}
function readCheckbox(p, name) { return Boolean(p?.[name]?.checkbox); }
function readRelation(p, name) { return (p?.[name]?.relation || []).map(r => r.id); }
function readDate(p, name) {
  const start = p?.[name]?.date?.start || "";
  const end = p?.[name]?.date?.end || "";
  const split = v => (!v ? { d: "", t: "" } : v.includes("T") ? { d: v.slice(0, 10), t: v.slice(11, 16) } : { d: v, t: "" });
  const s = split(start), e = split(end || start);
  return { date: s.d, time: s.t, endDate: e.d, endTime: e.t };
}

function normId(id) { return String(id || "").replace(/-/g, "").toLowerCase(); }

function nameProp(value) { return { rich_text: value ? [{ text: { content: value } }] : [] }; }
function selectProp(value) { return { select: value ? { name: value } : null }; }

function datePayload(date, time, endDate) {
  const start = time ? `${date}T${time}:00+09:00` : date;
  if (endDate && endDate !== date) return { start, end: time ? `${endDate}T23:59:00+09:00` : endDate };
  return { start };
}

function subtractDays(dateText, days) {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function monthRange(month) {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const raw = /^\d{4}-\d{2}$/.test(month || "") ? month : now.toISOString().slice(0, 7);
  const [y, m] = raw.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { month: raw, from: `${raw}-01`, to: `${raw}-${String(last).padStart(2, "0")}` };
}

/* ---------------- 권한 ---------------- */

function ownerOf(item, config) {
  return item.owner || config.ownerName;
}

function canEdit(item, session, config) {
  if (session.admin) return true;
  return ownerOf(item, config) === session.name || (item.author && item.author === session.name);
}

function validPerson(name, config) {
  return name === config.ownerName || config.members.some(m => m.name === name);
}

/* ---------------- 일정 ---------------- */

function mapSchedule(page, env, config) {
  const P = props(env);
  const p = page.properties || {};
  const d = readDate(p, P.schedule.date);
  const owner = readText(p, P.owner);
  const hiddenSet = new Set((config.hiddenProjects || []).map(normId));
  return {
    id: page.id,
    title: readTitle(p) || "제목 없음",
    ...d,
    canceled: readCheckbox(p, P.schedule.cancel),
    hidden: readCheckbox(p, P.hide),
    hiddenByProject: readRelation(p, P.schedule.project).some(id => hiddenSet.has(normId(id))),
    category: readText(p, P.schedule.category),
    owner: owner || config.ownerName,
    author: readText(p, P.author),
    kind: KINDS.includes(readText(p, P.kind)) ? readText(p, P.kind) : KINDS[0],
    memo: readText(p, P.memo),
  };
}

// 공유 범위: '공유 안 함'에 체크하지 않은 일정 전부.
// 체크한 일정은 멤버에게는 아예 내려주지 않고, 관리자에게만 '숨김' 표시로 보여 준다(다시 풀 수 있게).
function scheduleVisible(item, session) {
  return session.admin || (!item.hidden && !item.hiddenByProject);
}

/* ---------------- 아침 브리핑 ---------------- */

function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 그날(date)에 걸친 공유 일정: 취소·숨김 제외, 시간순(종일 먼저).
async function sharedSchedulesOn(env, config, date) {
  const P = props(env);
  const pages = await notionQueryAll(env, env.NOTION_SCHEDULE_DB_ID, {
    filter: { and: [
      { property: P.schedule.date, date: { on_or_after: subtractDays(date, RANGE_LOOKBACK_DAYS) } },
      { property: P.schedule.date, date: { on_or_before: date } },
    ] },
  });
  return pages
    .map(pg => mapSchedule(pg, env, config))
    .filter(it => !it.canceled && !it.hidden && !it.hiddenByProject && it.date && it.date <= date && (it.endDate || it.date) >= date)
    .map(it => ({ title: it.title, time: it.date === date ? it.time : "", endDate: it.endDate || it.date, owner: it.owner, kind: it.kind }))
    .sort((a, b) => (a.time || "").localeCompare(b.time || "") || a.title.localeCompare(b.title, "ko"));
}

async function briefing(env, dateParam) {
  const config = await getConfig(env);
  const date = isDate(dateParam) ? dateParam : kstToday();
  const schedules = await sharedSchedulesOn(env, config, date);
  // 지금은 공유 범위가 모두에게 같아서 멤버마다 같은 목록을 준다.
  const members = config.members.filter(m => m.siniId).map(m => ({ siniId: m.siniId, name: m.name, schedules }));
  return { date, ownerName: config.ownerName, members };
}

function briefingText(schedules) {
  const lines = schedules.slice(0, 6).map(s => `${s.time || "종일"} ${s.title}${s.owner ? ` (${s.owner})` : ""}`);
  if (schedules.length > 6) lines.push(`외 ${schedules.length - 6}개`);
  return lines.join("\n");
}

/* ---------------- Web Push (RFC 8291 aes128gcm + VAPID, 외부 라이브러리 없음) ---------------- */

const PUSH_KEY = "push:subs";
const enc = new TextEncoder();

function b64uToBytes(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
function bytesToB64u(bytes) {
  let s = "";
  for (const x of new Uint8Array(bytes)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

async function vapidAuthHeader(endpoint, env) {
  const pub = b64uToBytes(env.VAPID_PUBLIC);
  const jwk = { kty: "EC", crv: "P-256", x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), d: env.VAPID_PRIVATE, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "https://share.hyunra.kr",
  })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${payload}`));
  return `vapid t=${header}.${payload}.${bytesToB64u(sig)}, k=${env.VAPID_PUBLIC}`;
}

// 구독 정보로 payload를 암호화한 본문(aes128gcm)을 만든다.
async function encryptPushPayload(sub, payloadText) {
  const uaPublic = b64uToBytes(sub.keys.p256dh);
  const authSecret = b64uToBytes(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concatBytes(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concatBytes(enc.encode(payloadText), new Uint8Array([2])); // 마지막 레코드 구분자
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concatBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// 보내고 결과 상태 코드를 돌려준다. 404/410이면 구독이 끝난 것.
async function sendPush(sub, data, env) {
  const body = await encryptPushPayload(sub, JSON.stringify(data));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthHeader(sub.endpoint, env),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "43200",
      Urgency: "normal",
    },
    body,
  });
  return res.status;
}

async function getSubs(env) {
  return (await env.SHARE_KV.get(PUSH_KEY, "json")) || [];
}

function validSub(s) {
  try {
    const u = new URL(s?.endpoint || "");
    return u.protocol === "https:" && s.keys && b64uToBytes(s.keys.p256dh).length === 65 && b64uToBytes(s.keys.auth).length === 16;
  } catch { return false; }
}

async function pushSubscribe(request, env, session) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) throw httpError(503, "알림 설정이 아직 안 됐어요.");
  const body = await readBody(request);
  const sub = body.subscription;
  if (!validSub(sub)) throw httpError(400, "알림 등록 정보가 올바르지 않아요.");
  const subs = (await getSubs(env)).filter(s => s.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, name: session.name, admin: Boolean(session.admin), addedAt: new Date().toISOString() });
  await env.SHARE_KV.put(PUSH_KEY, JSON.stringify(subs.slice(-20)));
  return { registered: true };
}

async function pushUnsubscribe(request, env) {
  const body = await readBody(request);
  const subs = await getSubs(env);
  await env.SHARE_KV.put(PUSH_KEY, JSON.stringify(subs.filter(s => s.endpoint !== body.endpoint)));
  return { removed: true };
}

// 등록한 기기 중 지금 사람의 것에만 시험 알림
async function pushTest(request, env, session) {
  const body = await readBody(request);
  const subs = (await getSubs(env)).filter(s => s.endpoint === body.endpoint || (!body.endpoint && s.name === session.name));
  if (!subs.length) throw httpError(404, "이 기기는 아직 알림 등록이 안 됐어요.");
  const statuses = [];
  for (const s of subs) statuses.push(await sendPush(s, { title: "알림 테스트", body: "아침 8시에 이렇게 오늘 일정을 알려 드려요.", url: "./" }, env));
  return { statuses };
}

async function sendMorningBriefing(env) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return { sent: 0, reason: "no vapid" };
  const subs = await getSubs(env);
  if (!subs.length) return { sent: 0 };
  const config = await getConfig(env);
  const date = kstToday();
  const schedules = await sharedSchedulesOn(env, config, date);
  if (!schedules.length) return { sent: 0, reason: "no schedules" }; // 일정 없으면 안 보냄
  const data = { title: `오늘 일정 ${schedules.length}개`, body: briefingText(schedules), url: "./", tag: `brief-${date}` };
  const keep = [];
  let sent = 0;
  for (const s of subs) {
    let status = 0;
    try { status = await sendPush(s, data, env); } catch { status = 0; }
    if (status === 404 || status === 410) continue; // 끝난 구독은 정리
    if (status >= 200 && status < 300) sent++;
    keep.push(s);
  }
  if (keep.length !== subs.length) await env.SHARE_KV.put(PUSH_KEY, JSON.stringify(keep));
  return { sent };
}

async function listSchedules(url, env, session) {
  const config = await getConfig(env);
  const P = props(env);

  // 하자·AS 기록: 날짜와 상관없이 전부, 최근 것부터
  if (url.searchParams.get("kind") === "as") {
    let pages;
    try {
      pages = await notionQueryAll(env, env.NOTION_SCHEDULE_DB_ID, {
        filter: { property: P.kind, select: { equals: KINDS[1] } },
        sorts: [{ property: P.schedule.date, direction: "descending" }],
      });
    } catch { return []; } // 아직 '공유 분류' 속성이 없으면 기록도 없음
    return pages
      .map(pg => mapSchedule(pg, env, config))
      .filter(it => scheduleVisible(it, session) && !it.canceled);
  }

  const from = isDate(url.searchParams.get("from")) ? url.searchParams.get("from") : monthRange().from;
  const to = isDate(url.searchParams.get("to")) ? url.searchParams.get("to") : monthRange().to;
  // '공유 안 함' 속성이 아직 없을 수도 있어서 체크 여부는 코드에서 거른다.
  const pages = await notionQueryAll(env, env.NOTION_SCHEDULE_DB_ID, {
    filter: { and: [
      { property: P.schedule.date, date: { on_or_after: subtractDays(from, RANGE_LOOKBACK_DAYS) } },
      { property: P.schedule.date, date: { on_or_before: to } },
    ] },
    sorts: [{ property: P.schedule.date, direction: "ascending" }],
  });

  return pages
    .map(pg => mapSchedule(pg, env, config))
    .filter(it => scheduleVisible(it, session) && !it.canceled && it.date && (it.endDate || it.date) >= from);
}

async function loadScheduleInScope(env, config, id, session) {
  if (!id) throw httpError(400, "id가 필요해요.");
  const page = await notion(env, `/pages/${id}`);
  if (page.archived || page.in_trash) throw httpError(404, "이미 삭제된 일정이에요.");
  if (normId(page.parent?.data_source_id) !== normId(env.NOTION_SCHEDULE_DB_ID)) throw httpError(404, "공유된 일정이 아니에요.");
  const item = mapSchedule(page, env, config);
  if (!scheduleVisible(item, session)) throw httpError(404, "공유된 일정이 아니에요.");
  return item;
}

function scheduleFields(body, config, env, session, { create }) {
  const P = props(env);
  const out = {};
  if (create || body.title !== undefined) {
    const title = clean(body.title, 200);
    if (!title) throw httpError(400, "제목을 입력해 주세요.");
    out[P.schedule.title] = { title: [{ text: { content: title } }] };
  }
  if (create || body.date !== undefined) {
    if (!isDate(body.date)) throw httpError(400, "날짜를 확인해 주세요.");
    const time = isTime(body.time) ? body.time : "";
    const endDate = isDate(body.endDate) && body.endDate >= body.date ? body.endDate : "";
    out[P.schedule.date] = { date: datePayload(body.date, time, endDate) };
  }
  if (create || body.kind !== undefined) {
    out[P.kind] = selectProp(KINDS.includes(body.kind) ? body.kind : KINDS[0]);
  }
  if (create || body.memo !== undefined) {
    out[P.memo] = nameProp(String(body.memo ?? "").replace(/\r\n/g, "\n").trim().slice(0, MEMO_MAX));
  }
  // '공유 안 함'은 관리자만 바꿀 수 있다.
  if (body.hidden !== undefined && session.admin) {
    out[P.hide] = { checkbox: Boolean(body.hidden) };
  }
  return out;
}

// 담당자별 일정 카테고리: 멤버마다 정한 카테고리(예: 시은 → '언니'), 없으면 기본 카테고리.
function categoryForOwner(owner, config) {
  const member = config.members.find(m => m.name === owner);
  return (member && member.scheduleCategory) || config.defaultScheduleCategory || "";
}

async function createSchedule(request, env, session) {
  const config = await getConfig(env);
  const body = await readBody(request);
  const P = props(env);
  const owner = clean(body.owner, 40) || session.name;
  if (!validPerson(owner, config)) throw httpError(400, "담당자를 확인해 주세요.");

  const properties = scheduleFields(body, config, env, session, { create: true });
  properties[P.owner] = selectProp(owner);
  properties[P.author] = nameProp(session.name);
  const cat = categoryForOwner(owner, config);
  if (cat) properties[P.schedule.category] = selectProp(cat);

  const page = await notion(env, "/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: env.NOTION_SCHEDULE_DB_ID },
    properties,
  });
  return mapSchedule(page, env, config);
}

async function updateSchedule(request, env, session) {
  const config = await getConfig(env);
  const body = await readBody(request);
  const P = props(env);
  const current = await loadScheduleInScope(env, config, body.id, session);
  if (!canEdit(current, session, config)) throw httpError(403, "내 일정이나 내가 입력한 일정만 고칠 수 있어요.");

  const properties = scheduleFields(body, config, env, session, { create: false });
  if (body.owner !== undefined) {
    const owner = clean(body.owner, 40);
    if (!validPerson(owner, config)) throw httpError(400, "담당자를 확인해 주세요.");
    properties[P.owner] = selectProp(owner);
    // 담당자가 바뀌면, 카테고리가 비어 있거나 이전 담당자의 자동 카테고리였을 때만 새 담당자 것으로 바꾼다.
    const prevAuto = categoryForOwner(current.owner, config);
    if (owner !== current.owner && (!current.category || current.category === prevAuto)) {
      const cat = categoryForOwner(owner, config);
      if (cat) properties[P.schedule.category] = selectProp(cat);
    }
  }

  const page = await notion(env, `/pages/${current.id}`, "PATCH", { properties });
  return mapSchedule(page, env, config);
}

async function deleteSchedule(request, env, session) {
  const config = await getConfig(env);
  const body = await readBody(request);
  const current = await loadScheduleInScope(env, config, body.id, session);
  if (!canEdit(current, session, config)) throw httpError(403, "내 일정이나 내가 입력한 일정만 지울 수 있어요.");
  await notion(env, `/pages/${current.id}`, "PATCH", { archived: true });
  return { id: current.id };
}

/* ---------------- 지출 ---------------- */

function mapExpense(page, env, config) {
  const P = props(env);
  const p = page.properties || {};
  const owner = readText(p, P.owner);
  return {
    id: page.id,
    title: readTitle(p) || "지출",
    date: readDate(p, P.expense.date).date,
    amount: readNumber(p, P.expense.amount),
    category: readText(p, P.expense.subject),
    owner: owner || config.ownerName,
    author: readText(p, P.author),
    createdTime: page.created_time || "",
  };
}

function expenseInScope(item, config) {
  return config.categories.includes(item.category);
}

async function listExpenses(url, env) {
  const config = await getConfig(env);
  const range = monthRange(url.searchParams.get("month"));
  if (!config.categories.length) return { month: range.month, records: [], total: 0, byCategory: {}, byOwner: {} };

  const P = props(env);
  const pages = await notionQueryAll(env, env.NOTION_EXPENSE_DB_ID, {
    filter: { and: [
      { property: P.expense.date, date: { on_or_after: range.from } },
      { property: P.expense.date, date: { on_or_before: range.to } },
    ] },
    sorts: [{ property: P.expense.date, direction: "descending" }],
  });

  // 카테고리 속성 타입(select/multi_select)에 상관없이 동작하도록 코드에서 거른다.
  const records = pages
    .map(pg => mapExpense(pg, env, config))
    .filter(r => expenseInScope(r, config))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdTime.localeCompare(a.createdTime));

  const byCategory = {}, byOwner = {};
  let total = 0;
  for (const r of records) {
    total += r.amount;
    byCategory[r.category] = (byCategory[r.category] || 0) + r.amount;
    byOwner[r.owner] = (byOwner[r.owner] || 0) + r.amount;
  }
  return { month: range.month, records, total, byCategory, byOwner };
}

async function loadExpenseInScope(env, config, id) {
  if (!id) throw httpError(400, "id가 필요해요.");
  const page = await notion(env, `/pages/${id}`);
  if (page.archived || page.in_trash) throw httpError(404, "이미 삭제된 내역이에요.");
  if (normId(page.parent?.data_source_id) !== normId(env.NOTION_EXPENSE_DB_ID)) throw httpError(404, "공유된 내역이 아니에요.");
  const item = mapExpense(page, env, config);
  if (!expenseInScope(item, config)) throw httpError(404, "공유된 내역이 아니에요.");
  return item;
}

function expenseFields(body, config, env, { create }) {
  const P = props(env);
  const out = {};
  if (create || body.title !== undefined) {
    const title = clean(body.title, 200);
    if (!title) throw httpError(400, "내용을 입력해 주세요.");
    out[P.expense.title] = { title: [{ text: { content: title } }] };
  }
  if (create || body.date !== undefined) {
    if (!isDate(body.date)) throw httpError(400, "날짜를 확인해 주세요.");
    out[P.expense.date] = { date: { start: body.date } };
  }
  if (create || body.amount !== undefined) {
    const amount = Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, "금액을 확인해 주세요.");
    out[P.expense.amount] = { number: amount };
  }
  if (create || body.category !== undefined) {
    if (!config.categories.includes(body.category)) throw httpError(400, "공유된 카테고리를 골라 주세요.");
    out[P.expense.subject] = selectProp(body.category);
  }
  if (create && P.expense.done) out[P.expense.done] = { checkbox: true };
  return out;
}

async function createExpense(request, env, session) {
  const config = await getConfig(env);
  const body = await readBody(request);
  const P = props(env);
  const owner = clean(body.owner, 40) || session.name;
  if (!validPerson(owner, config)) throw httpError(400, "담당자를 확인해 주세요.");

  const properties = expenseFields(body, config, env, { create: true });
  properties[P.owner] = selectProp(owner);
  properties[P.author] = nameProp(session.name);

  const page = await notion(env, "/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: env.NOTION_EXPENSE_DB_ID },
    properties,
  });
  return mapExpense(page, env, config);
}

async function updateExpense(request, env, session) {
  const config = await getConfig(env);
  const body = await readBody(request);
  const P = props(env);
  const current = await loadExpenseInScope(env, config, body.id);
  if (!canEdit(current, session, config)) throw httpError(403, "내 지출이나 내가 입력한 지출만 고칠 수 있어요.");

  const properties = expenseFields(body, config, env, { create: false });
  if (body.owner !== undefined) {
    const owner = clean(body.owner, 40);
    if (!validPerson(owner, config)) throw httpError(400, "담당자를 확인해 주세요.");
    properties[P.owner] = selectProp(owner);
  }
  const page = await notion(env, `/pages/${current.id}`, "PATCH", { properties });
  return mapExpense(page, env, config);
}

async function deleteExpense(request, env, session) {
  const config = await getConfig(env);
  const body = await readBody(request);
  const current = await loadExpenseInScope(env, config, body.id);
  if (!canEdit(current, session, config)) throw httpError(403, "내 지출이나 내가 입력한 지출만 지울 수 있어요.");
  await notion(env, `/pages/${current.id}`, "PATCH", { archived: true });
  return { id: current.id };
}

/* ---------------- 관리자 ---------------- */

async function adminOptions(env) {
  const P = props(env);
  const [expenseSchema, scheduleSchema, projectPages] = await Promise.all([
    notion(env, `/data_sources/${env.NOTION_EXPENSE_DB_ID}`),
    notion(env, `/data_sources/${env.NOTION_SCHEDULE_DB_ID}`),
    env.NOTION_PROJECT_DB_ID ? notionQueryAll(env, env.NOTION_PROJECT_DB_ID).catch(() => []) : [],
  ]);
  const projects = projectPages
    .filter(pg => !pg.archived && !pg.in_trash)
    .map(pg => ({ id: normId(pg.id), title: readTitle(pg.properties) || "제목 없음", status: readText(pg.properties, P.project.status) }))
    .sort((a, b) => a.title.localeCompare(b.title, "ko"));

  const subject = expenseSchema.properties?.[P.expense.subject];
  const categories = (subject?.select?.options || subject?.multi_select?.options || []).map(o => o.name);

  const schedCat = scheduleSchema.properties?.[P.schedule.category];
  const scheduleCategories = (schedCat?.select?.options || []).map(o => o.name);

  const has = (schema, names) => names.every(n => schema.properties?.[n]);
  const notionReady = {
    schedule: has(scheduleSchema, [P.owner, P.author, P.memo, P.kind, P.hide]),
    expense: has(expenseSchema, [P.owner, P.author]),
  };

  return { categories, scheduleCategories, projects, notionReady, hideProp: P.hide };
}

// Notion 준비. 이미 있는 것은 건너뜀.
// - 일정 DB: '공유 안 함'(체크박스), '공유 담당자'(선택), '공유 작성자'(텍스트), '공유 메모'(텍스트), '공유 분류'(선택: 일정/하자·AS)
// - 지출 DB: '공유 담당자'(선택), '공유 작성자'(텍스트)
async function setupNotionProps(env) {
  const P = props(env);
  const result = {};
  for (const [key, id] of [["schedule", env.NOTION_SCHEDULE_DB_ID], ["expense", env.NOTION_EXPENSE_DB_ID]]) {
    const schema = await notion(env, `/data_sources/${id}`);
    const add = {};
    if (key === "schedule" && !schema.properties?.[P.hide]) add[P.hide] = { checkbox: {} };
    if (!schema.properties?.[P.owner]) add[P.owner] = { select: {} };
    if (!schema.properties?.[P.author]) add[P.author] = { rich_text: {} };
    if (key === "schedule") {
      if (!schema.properties?.[P.memo]) add[P.memo] = { rich_text: {} };
      if (!schema.properties?.[P.kind]) add[P.kind] = { select: { options: [{ name: KINDS[0], color: "default" }, { name: KINDS[1], color: "orange" }] } };
    }
    if (Object.keys(add).length) await notion(env, `/data_sources/${id}`, "PATCH", { properties: add });
    result[key] = Object.keys(add);
  }
  return { added: result };
}