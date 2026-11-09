/* =========================================================
   Paper Log Share Worker
   - PaperLog의 일부(공개한 프로젝트의 일정, 공개한 카테고리의 지출)만
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

      if (path === "/api/schedules" && method === "GET") return json({ ok: true, schedules: await listSchedules(url, env) }, 200, cors);
      if (path === "/api/schedules" && method === "POST") return json({ ok: true, item: await createSchedule(request, env, session) }, 200, cors);
      if (path === "/api/schedules" && method === "PATCH") return json({ ok: true, item: await updateSchedule(request, env, session) }, 200, cors);
      if (path === "/api/schedules" && method === "DELETE") return json({ ok: true, ...(await deleteSchedule(request, env, session)) }, 200, cors);

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
};

/* ---------------- 공통 ---------------- */

function corsHeaders(request, env) {
  const allowed = String(env.CORS_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : allowed[0] || "");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-share-token",
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
  };
}

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
    projects: [],      // [{ id, title }]
    categories: [],    // ["식비", ...]
    defaultScheduleCategory: "",
    members: [],       // [{ name, salt, hash }]
    ...(raw || {}),
  };
}

function publicConfig(config) {
  return {
    appName: config.appName,
    ownerName: config.ownerName,
    projects: config.projects,
    categories: config.categories,
    people: [config.ownerName, ...config.members.map(m => m.name)],
  };
}

function adminView(config) {
  return { ...config, members: config.members.map(m => ({ name: m.name, hasCode: Boolean(m.hash) })) };
}

function publicMe(session) {
  return { name: session.name, admin: Boolean(session.admin) };
}

function tokenOf(request) {
  return request.headers.get("x-share-token") || "";
}

async function getSession(request, env) {
  const token = tokenOf(request);
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

  if (Array.isArray(body.projects)) {
    config.projects = body.projects
      .filter(p => p && p.id)
      .map(p => ({ id: clean(p.id, 64), title: clean(p.title, 100) }));
  }
  if (Array.isArray(body.categories)) {
    config.categories = [...new Set(body.categories.map(c => clean(c, 60)).filter(Boolean))];
  }

  // members: [{ name, code? }] — code가 있으면 새로 설정, 없으면 기존 코드 유지
  if (Array.isArray(body.members)) {
    const old = new Map(config.members.map(m => [m.name, m]));
    const next = [];
    const seen = new Set([config.ownerName]);
    for (const m of body.members) {
      const name = clean(m?.name, 40);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const code = String(m.code || "");
      if (code) {
        if (code.length < 4) throw httpError(400, `${name}님의 코드는 4자 이상이어야 해요.`);
        const salt = randomHex(8);
        next.push({ name, salt, hash: await sha256Hex(`${salt}:${code}`) });
      } else if (old.has(name)) {
        next.push(old.get(name));
      } else {
        throw httpError(400, `${name}님의 코드를 정해 주세요.`);
      }
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
  const projectIds = readRelation(p, P.schedule.project);
  const shared = new Map(config.projects.map(x => [normId(x.id), x]));
  const projects = projectIds.map(id => shared.get(normId(id))).filter(Boolean);
  const owner = readText(p, P.owner);
  return {
    id: page.id,
    title: readTitle(p) || "제목 없음",
    ...d,
    canceled: readCheckbox(p, P.schedule.cancel),
    projects: projects.map(x => ({ id: x.id, title: x.title })),
    owner: owner || config.ownerName,
    author: readText(p, P.author),
    _ownerRaw: owner,
  };
}

function scheduleInScope(item) {
  return item.projects.length > 0;
}

async function listSchedules(url, env) {
  const config = await getConfig(env);
  if (!config.projects.length) return [];
  const P = props(env);
  const from = isDate(url.searchParams.get("from")) ? url.searchParams.get("from") : monthRange().from;
  const to = isDate(url.searchParams.get("to")) ? url.searchParams.get("to") : monthRange().to;

  // 공개 프로젝트 중 하나라도 연결된 일정만 Notion에서 가져온다.
  const projectFilter = config.projects.map(x => ({ property: P.schedule.project, relation: { contains: x.id } }));
  const filter = {
    and: [
      { property: P.schedule.date, date: { on_or_after: subtractDays(from, RANGE_LOOKBACK_DAYS) } },
      { property: P.schedule.date, date: { on_or_before: to } },
      projectFilter.length === 1 ? projectFilter[0] : { or: projectFilter },
    ],
  };
  const pages = await notionQueryAll(env, env.NOTION_SCHEDULE_DB_ID, {
    filter, sorts: [{ property: P.schedule.date, direction: "ascending" }],
  });

  return pages
    .map(pg => mapSchedule(pg, env, config))
    .filter(it => scheduleInScope(it) && !it.canceled && it.date && (it.endDate || it.date) >= from)
    .map(({ _ownerRaw, ...it }) => it);
}

async function loadScheduleInScope(env, config, id) {
  if (!id) throw httpError(400, "id가 필요해요.");
  const page = await notion(env, `/pages/${id}`);
  if (page.archived || page.in_trash) throw httpError(404, "이미 삭제된 일정이에요.");
  if (normId(page.parent?.data_source_id) !== normId(env.NOTION_SCHEDULE_DB_ID)) throw httpError(404, "공유된 일정이 아니에요.");
  const item = mapSchedule(page, env, config);
  if (!scheduleInScope(item)) throw httpError(404, "공유된 일정이 아니에요.");
  return item;
}

function scheduleFields(body, config, env, { create }) {
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
  if (create || body.projectId !== undefined) {
    const proj = config.projects.find(x => normId(x.id) === normId(body.projectId));
    if (!proj) throw httpError(400, "공유된 프로젝트를 골라 주세요.");
    out[P.schedule.project] = { relation: [{ id: proj.id }] };
  }
  if (create && config.defaultScheduleCategory) {
    out[P.schedule.category] = selectProp(config.defaultScheduleCategory);
  }
  return out;
}

async function createSchedule(request, env, session) {
  const config = await getConfig(env);
  const body = await readBody(request);
  const P = props(env);
  const owner = clean(body.owner, 40) || session.name;
  if (!validPerson(owner, config)) throw httpError(400, "담당자를 확인해 주세요.");

  const properties = scheduleFields(body, config, env, { create: true });
  properties[P.owner] = selectProp(owner);
  properties[P.author] = nameProp(session.name);

  const page = await notion(env, "/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: env.NOTION_SCHEDULE_DB_ID },
    properties,
  });
  const { _ownerRaw, ...item } = mapSchedule(page, env, config);
  return item;
}

async function updateSchedule(request, env, session) {
  const config = await getConfig(env);
  const body = await readBody(request);
  const P = props(env);
  const current = await loadScheduleInScope(env, config, body.id);
  if (!canEdit(current, session, config)) throw httpError(403, "내 일정이나 내가 입력한 일정만 고칠 수 있어요.");

  const properties = scheduleFields(body, config, env, { create: false });
  if (body.owner !== undefined) {
    const owner = clean(body.owner, 40);
    if (!validPerson(owner, config)) throw httpError(400, "담당자를 확인해 주세요.");
    properties[P.owner] = selectProp(owner);
  }

  // 공유 프로젝트 외에 원래 연결돼 있던(비공개) 프로젝트는 지우지 않고 유지한다.
  if (properties[P.schedule.project]) {
    const page = await notion(env, `/pages/${current.id}`);
    const sharedIds = new Set(config.projects.map(x => normId(x.id)));
    const keep = readRelation(page.properties, P.schedule.project).filter(id => !sharedIds.has(normId(id)));
    properties[P.schedule.project].relation.push(...keep.map(id => ({ id })));
  }

  const page = await notion(env, `/pages/${current.id}`, "PATCH", { properties });
  const { _ownerRaw, ...item } = mapSchedule(page, env, config);
  return item;
}

async function deleteSchedule(request, env, session) {
  const config = await getConfig(env);
  const body = await readBody(request);
  const current = await loadScheduleInScope(env, config, body.id);
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
  const [projectPages, expenseSchema] = await Promise.all([
    notionQueryAll(env, env.NOTION_PROJECT_DB_ID, { sorts: [{ property: P.project.title, direction: "ascending" }] }),
    notion(env, `/data_sources/${env.NOTION_EXPENSE_DB_ID}`),
  ]);
  const scheduleSchema = await notion(env, `/data_sources/${env.NOTION_SCHEDULE_DB_ID}`);

  const projects = projectPages.map(pg => ({
    id: pg.id,
    title: readTitle(pg.properties) || "이름 없음",
    status: readText(pg.properties, P.project.status),
  }));

  const subject = expenseSchema.properties?.[P.expense.subject];
  const categories = (subject?.select?.options || subject?.multi_select?.options || []).map(o => o.name);

  const schedCat = scheduleSchema.properties?.[P.schedule.category];
  const scheduleCategories = (schedCat?.select?.options || []).map(o => o.name);

  const notionReady = {
    schedule: Boolean(scheduleSchema.properties?.[P.owner] && scheduleSchema.properties?.[P.author]),
    expense: Boolean(expenseSchema.properties?.[P.owner] && expenseSchema.properties?.[P.author]),
  };

  return { projects, categories, scheduleCategories, notionReady, ownerProp: P.owner, authorProp: P.author };
}

// 일정 DB와 지출 DB에 '공유 담당자'(선택), '공유 작성자'(텍스트) 속성을 추가한다. 이미 있으면 건너뜀.
async function setupNotionProps(env) {
  const P = props(env);
  const result = {};
  for (const [key, id] of [["schedule", env.NOTION_SCHEDULE_DB_ID], ["expense", env.NOTION_EXPENSE_DB_ID]]) {
    const schema = await notion(env, `/data_sources/${id}`);
    const add = {};
    if (!schema.properties?.[P.owner]) add[P.owner] = { select: {} };
    if (!schema.properties?.[P.author]) add[P.author] = { rich_text: {} };
    if (Object.keys(add).length) await notion(env, `/data_sources/${id}`, "PATCH", { properties: add });
    result[key] = Object.keys(add);
  }
  return { added: result };
}
