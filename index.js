import { FAVICON_BYTES } from "./assets/favicon.js";

const SESSION_TTL = 8 * 60 * 60;
const MAX_BODY_BYTES = 35 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_RECIPIENTS = 50;
const LIMITS = { login: [10, 60], send: [20, 60] };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png")
    )
      return favicon();
    if (request.method === "GET" && url.pathname === "/login") {
      const n = nonce();
      return page(loginPage(n), request, n);
    }
    if (request.method === "POST" && url.pathname === "/login")
      return login(request, env);
    if (request.method === "POST" && url.pathname === "/logout")
      return logout(request, env);
    if (request.method === "GET" && url.pathname === "/") {
      const session = await requireSession(request, env);
      if (!session) return redirect("/login");
      const n = nonce();
      return page(composePage(session.nonce, env, n), request, n);
    }
    if (request.method === "POST" && url.pathname === "/api/send") {
      const session = await requireSession(request, env);
      return session
        ? send(request, env, session)
        : json({ error: "请先登录" }, 401);
    }
    return json({ error: "Not Found" }, 404);
  },
};

async function login(request, env) {
  if (!sameOrigin(request) || !isJson(request))
    return json({ error: "无效请求" }, 403);
  const configured = String(env.PASSWD || "");
  if (!isConfiguredPassword(configured))
    return json({ error: "密码错误或服务未配置" }, 401);
  if (!(await limit(env, "login:" + clientIp(request), ...LIMITS.login)))
    return json({ error: "请求过于频繁" }, 429);
  const parsed = await readJson(request);
  if (!parsed.ok)
    return json(
      { error: parsed.reason === "too_large" ? "请求体过大" : "请求格式无效" },
      parsed.reason === "too_large" ? 413 : 400,
    );
  const body = parsed.value;
  if (!(await equal(String(body?.password || ""), configured)))
    return json({ error: "密码错误或服务未配置" }, 401);
  const session = {
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
    nonce: crypto.randomUUID(),
  };
  const token = await sign(session, configured);
  return json({ ok: true }, 200, {
    "Set-Cookie": sessionCookie(token, SESSION_TTL),
  });
}

async function logout(request, env) {
  const session = await requireSession(request, env);
  if (!session || !(await validCsrf(request, session)))
    return json({ error: "无效请求" }, 403);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
}

async function send(request, env, session) {
  if (
    !env.API_KEY ||
    !validDomain(env.DOMAIN) ||
    !isConfiguredPassword(String(env.PASSWD || ""))
  )
    return json({ error: "服务未完成安全配置" }, 503);
  if (!isJson(request)) return json({ error: "需要 JSON 请求" }, 415);
  if (!(await validCsrf(request, session)))
    return json({ error: "CSRF 校验失败" }, 403);
  if (!(await limit(env, "send:" + clientIp(request), ...LIMITS.send)))
    return json({ error: "发送过于频繁" }, 429);
  const key = request.headers.get("Idempotency-Key") || "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key))
    return json({ error: "需要有效的幂等键" }, 400);
  const parsedBody = await readJson(request);
  if (!parsedBody.ok)
    return json(
      {
        error:
          parsedBody.reason === "too_large" ? "请求体过大" : "请求格式无效",
      },
      parsedBody.reason === "too_large" ? 413 : 400,
    );
  const parsed = validateMessage(parsedBody.value, env);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status || 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: ["Bearer", env.API_KEY].join(" "),
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(parsed.payload),
    });
  } catch {
    return json({ error: "邮件服务网络错误，请稍后重试" }, 502);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return json({ error: "邮件服务暂时不可用" }, 502);
  let result;
  try {
    result = await response.json();
  } catch {
    return json({ error: "邮件服务响应无效" }, 502);
  }
  return json({ ok: true, id: result?.id || null });
}

function validateMessage(body, env) {
  if (!body || typeof body !== "object")
    return { ok: false, error: "请求格式无效" };
  const to = emails(body.to),
    cc = emails(body.cc),
    bcc = emails(body.bcc);
  const subject = String(body.subject || "").trim();
  const text = String(body.text || "");
  const html = body.html == null ? "" : String(body.html);
  const recipients = [...to, ...cc, ...bcc];
  const uniqueRecipients = new Set(
    recipients.map((email) => email.toLowerCase()),
  );
  if (
    !to.length ||
    recipients.length > MAX_RECIPIENTS ||
    uniqueRecipients.size !== recipients.length ||
    recipients.some((e) => !isEmail(e))
  )
    return { ok: false, error: "收件人格式无效" };
  if (
    !subject ||
    subject.length > 200 ||
    /[\r\n]/.test(subject) ||
    (!text && !html) ||
    text.length > 100000 ||
    html.length > 200000
  )
    return { ok: false, error: "主题或正文格式无效" };
  const prefix = String(body.fromPrefix || env.PREFIX || "noreply").trim();
  const fromName = String(
    Object.hasOwn(body, "fromName") ? body.fromName || "" : env.NAME || "",
  ).trim();
  const replyTo = String(body.replyTo || "").trim();
  if (
    !validPrefix(prefix) ||
    fromName.length > 100 ||
    /[\r\n<>]/.test(fromName) ||
    (replyTo && !isEmail(replyTo))
  )
    return { ok: false, error: "发件人或 Reply-To 格式无效" };
  const attachments = [],
    input = Array.isArray(body.attachments) ? body.attachments : [];
  let total = 0;
  if (input.length > MAX_ATTACHMENTS)
    return { ok: false, error: "附件数量超过限制", status: 413 };
  for (const item of input) {
    if (
      !item ||
      typeof item.filename !== "string" ||
      typeof item.content !== "string" ||
      !/^[^\\/<>:"|?*\x00-\x1f]{1,120}$/.test(item.filename)
    )
      return { ok: false, error: "附件格式无效" };
    let size;
    try {
      size = atob(item.content).length;
    } catch {
      return { ok: false, error: "附件编码无效" };
    }
    total += size;
    if (
      !size ||
      size > MAX_ATTACHMENT_BYTES ||
      total > MAX_TOTAL_ATTACHMENT_BYTES
    )
      return { ok: false, error: "附件超过大小限制", status: 413 };
    attachments.push({
      filename: item.filename,
      content: item.content,
      ...(item.type ? { type: String(item.type).slice(0, 100) } : {}),
    });
  }
  const payload = {
    from: fromName
      ? `${fromName} <${prefix}@${env.DOMAIN}>`
      : `${prefix}@${env.DOMAIN}`,
    to,
    subject,
    text,
    attachments,
  };
  if (cc.length) payload.cc = cc;
  if (bcc.length) payload.bcc = bcc;
  if (html) payload.html = html;
  if (replyTo) payload.reply_to = replyTo;
  return { ok: true, payload };
}

async function requireSession(request, env) {
  const password = String(env.PASSWD || "");
  if (!isConfiguredPassword(password)) return null;
  const token = getCookie(request.headers.get("Cookie"), "mail_session");
  return token ? verify(token, password) : null;
}
async function validCsrf(request, session) {
  const value = request.headers.get("X-CSRF-Token") || "";
  return value.length > 0 && (await equal(value, session.nonce));
}
async function limit(env, key, max, seconds) {
  if (!env.RATE_LIMITER?.idFromName || !env.RATE_LIMITER?.get) return false;
  try {
    const id = env.RATE_LIMITER.idFromName(key);
    const response = await env.RATE_LIMITER.get(id).fetch("https://rate/", {
      method: "POST",
      body: JSON.stringify({ max, seconds }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class RateLimiter {
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const { max, seconds } = await request.json();
    const now = Math.floor(Date.now() / 1000);
    let allowed = false;
    await this.state.storage.transaction(async (tx) => {
      const current = (await tx.get("counter")) || { count: 0, start: now };
      if (now - current.start >= seconds) {
        current.count = 0;
        current.start = now;
      }
      current.count += 1;
      allowed = current.count <= max;
      await tx.put("counter", current);
      await this.state.storage.setAlarm((current.start + seconds) * 1000);
    });
    return new Response(null, { status: allowed ? 204 : 429 });
  }
  async alarm() {
    await this.state.storage.delete("counter");
  }
}

async function sign(data, secret) {
  const raw = b64(JSON.stringify(data));
  return `${raw}.${b64(await hmac(raw, secret))}`;
}
async function verify(token, secret) {
  try {
    const [raw, sig] = token.split(".");
    if (
      !raw ||
      !sig ||
      !(await equalBytes(fromB64(sig), await hmac(raw, secret)))
    )
      return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64(raw)));
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}
async function equal(a, b) {
  return equalBytes(new TextEncoder().encode(a), new TextEncoder().encode(b));
}
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}
function b64(value) {
  return btoa(typeof value === "string" ? value : String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function fromB64(value) {
  const s = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}
function getCookie(value, name) {
  return (value || "")
    .split(";")
    .map((x) => x.trim().split("="))
    .find((x) => x[0] === name)
    ?.slice(1)
    .join("=");
}
function sessionCookie(value, age) {
  return `mail_session=${value}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
function isConfiguredPassword(value) {
  return value.length > 0;
}
function validDomain(value) {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(
      value,
    )
  );
}
function validPrefix(value) {
  return (
    value.length >= 1 &&
    value.length <= 64 &&
    /^[A-Za-z0-9%+_-]+(?:\.[A-Za-z0-9%+_-]+)*$/.test(value)
  );
}
function emails(value) {
  return Array.isArray(value)
    ? value
        .map(String)
        .map((x) => x.trim())
        .filter(Boolean)
    : String(value || "")
        .split(/[\s,;]+/)
        .filter(Boolean);
}
function isEmail(value) {
  return value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}
function isJson(request) {
  return (
    (request.headers.get("Content-Type") || "").toLowerCase().split(";")[0] ===
    "application/json"
  );
}
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}
function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}
async function readJson(request) {
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES)
    return { ok: false, reason: "too_large" };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: "invalid_json" };
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) return { ok: false, reason: "too_large" };
      chunks.push(part.value);
    }
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: headers({
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    }),
  });
}
function favicon() {
  return new Response(FAVICON_BYTES, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: headers({ Location: location }),
  });
}
function page(body, request, pageNonce) {
  return new Response(body, {
    headers: headers(
      { "Content-Type": "text/html; charset=utf-8" },
      request,
      pageNonce,
    ),
  });
}
function headers(extra = {}, request, pageNonce) {
  return new Headers({
    ...extra,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": `default-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${pageNonce || "none"}'; base-uri 'none'; frame-ancestors 'none'`,
  });
}
function nonce() {
  return b64(crypto.getRandomValues(new Uint8Array(18)));
}
function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function faviconLink() {
  return '<link rel="icon" href="/favicon.png" type="image/png" sizes="64x64">';
}
function loginPage(n) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${faviconLink()}<title>登录 · Mail-CF</title><style>${css()}</style></head><body><main><section><h1>Mail-CF</h1><p>安全登录后发送邮件</p><form id="login"><label for="password">网页密码</label><input id="password" type="password" autocomplete="current-password" required><button type="submit">登录</button><output id="message" aria-live="polite"></output></form></section></main><script nonce="${n}">const loginForm=document.getElementById('login');const passwordInput=document.getElementById('password');const loginButton=loginForm.querySelector('button[type=submit]');const loginMessage=document.getElementById('message');const readError=async response=>{try{const data=await response.json();return typeof data?.error==='string'&&data.error.trim()?data.error:'请求失败（HTTP '+response.status+'）'}catch{return '请求失败（HTTP '+response.status+'）'}};loginForm.addEventListener('submit',async event=>{event.preventDefault();if(loginButton.disabled)return;loginButton.disabled=true;loginButton.textContent='登录中…';loginMessage.textContent='';try{const response=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:passwordInput.value})});if(response.ok)location='/';else loginMessage.textContent=await readError(response)}catch{loginMessage.textContent='网络错误，请稍后重试'}finally{loginButton.disabled=false;loginButton.textContent='登录'}});</script></body></html>`;
}
function composePage(sessionNonce, env, n) {
  const domain = String(env.DOMAIN || "").trim();
  const domainHint = domain
    ? `<span class="breakable">${esc(domain)}</span>`
    : '<span class="domain-warning">未配置，请检查 DOMAIN</span>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${faviconLink()}<title>发信 · Mail-CF</title><style>${css()}</style></head><body><main><section><header><h1>发送邮件</h1><button id="logout" type="button">退出</button></header><p class="hint">发件域名：${domainHint}</p><form id="compose"><div class="field"><label for="to">收件人</label><input id="to" placeholder="可用逗号分隔" autocomplete="email" required></div><div class="field"><label for="cc">抄送（可选）</label><input id="cc" placeholder="可用逗号分隔"></div><div class="field"><label for="bcc">密送（可选）</label><input id="bcc" placeholder="可用逗号分隔"></div><div class="field"><label for="fromPrefix">发件前缀</label><input id="fromPrefix" placeholder="如 noreply" required></div><div class="field"><label for="fromName">发件人名称（可选）</label><input id="fromName" maxlength="100" value="${esc(env.NAME || "")}"></div><div class="field"><label for="replyTo">Reply-To（可选）</label><input id="replyTo" type="email" inputmode="email"></div><div class="field"><label for="subject">主题</label><input id="subject" maxlength="200" required></div><div class="field"><label for="text">纯文本正文</label><textarea id="text"></textarea></div><div class="field"><label for="html">富文本 HTML（可选）</label><textarea id="html"></textarea></div><div class="field"><label for="chooseFiles">附件（可选）</label><div class="file-picker"><button id="chooseFiles" type="button" aria-label="选择文件，附件（可选）" aria-controls="files" aria-describedby="fileStatus"><span>选择文件</span></button><span id="fileStatus" role="status"><span id="fileStatusText">未选择文件</span></span><input id="files" type="file" multiple hidden aria-label="附件（可选）"></div><div id="fileNames" class="file-names" aria-live="polite"></div></div><button id="send" type="submit">发送</button><output id="message" aria-live="polite"></output></form></section></main><script nonce="${n}">const csrf=${JSON.stringify(sessionNonce)};const maxFiles=${MAX_ATTACHMENTS};const maxFileBytes=${MAX_ATTACHMENT_BYTES};const maxTotalFileBytes=${MAX_TOTAL_ATTACHMENT_BYTES};const composeForm=document.getElementById('compose');const toInput=document.getElementById('to');const ccInput=document.getElementById('cc');const bccInput=document.getElementById('bcc');const fromPrefixInput=document.getElementById('fromPrefix');const fromNameInput=document.getElementById('fromName');const replyToInput=document.getElementById('replyTo');const subjectInput=document.getElementById('subject');const textInput=document.getElementById('text');const htmlInput=document.getElementById('html');const filesInput=document.getElementById('files');const fileNames=document.getElementById('fileNames');const chooseFiles=document.getElementById('chooseFiles');const fileStatusText=document.getElementById('fileStatusText');chooseFiles.addEventListener('click',()=>{if(!sending)filesInput.click()});const sendButton=document.getElementById('send');const message=document.getElementById('message');const logoutButton=document.getElementById('logout');let sending=false;let selectedFiles=[];const readError=async response=>{try{const data=await response.json();return typeof data?.error==='string'&&data.error.trim()?data.error:'请求失败（HTTP '+response.status+'）'}catch{return '请求失败（HTTP '+response.status+'）'}};const renderFiles=()=>{const files=[...filesInput.files];selectedFiles=files;fileStatusText.textContent=files.length===0?'未选择文件':files.length===1?files[0].name:'已选择 '+files.length+' 个文件';fileStatusText.title=fileStatusText.textContent;fileNames.replaceChildren();files.forEach((file,index)=>{const row=document.createElement('div');row.className='file-item';const name=document.createElement('span');name.textContent=file.name;const remove=document.createElement('button');remove.type='button';remove.className='file-remove';remove.textContent='×';remove.title='删除附件';remove.setAttribute('aria-label','删除附件 '+file.name);remove.disabled=sending;remove.addEventListener('click',()=>{if(sending)return;const transfer=new DataTransfer();[...filesInput.files].forEach((item,i)=>{if(i!==index)transfer.items.add(item)});filesInput.files=transfer.files;delete composeForm.dataset.key;renderFiles();const next=fileNames.querySelectorAll('button');(next[Math.min(index,next.length-1)]||chooseFiles).focus()});row.append(name,remove);fileNames.append(row)});const oversized=files.find(file=>file.size>maxFileBytes);const total=files.reduce((sum,file)=>sum+file.size,0);if(files.length>maxFiles)message.textContent='附件数量超过 10 个限制';else if(oversized)message.textContent='附件“'+oversized.name+'”超过 10 MiB 限制';else if(total>maxTotalFileBytes)message.textContent='附件总大小超过 25 MiB 限制';else message.textContent=''};filesInput.addEventListener('change',()=>{const transfer=new DataTransfer();const files=[...selectedFiles];if(!sending){for(const file of filesInput.files){if(!files.some(item=>item.name===file.name&&item.size===file.size&&item.lastModified===file.lastModified&&item.type===file.type))files.push(file)}}files.forEach(file=>transfer.items.add(file));filesInput.files=transfer.files;if(sending)return;delete composeForm.dataset.key;renderFiles()});composeForm.addEventListener('submit',async event=>{event.preventDefault();if(sending)return;const files=[...filesInput.files];const oversized=files.find(file=>file.size>maxFileBytes);const total=files.reduce((sum,file)=>sum+file.size,0);if(files.length>maxFiles){message.textContent='附件数量超过 10 个限制';return}if(oversized){message.textContent='附件“'+oversized.name+'”超过 10 MiB 限制';return}if(total>maxTotalFileBytes){message.textContent='附件总大小超过 25 MiB 限制';return}sending=true;filesInput.disabled=true;chooseFiles.disabled=true;fileNames.querySelectorAll('button').forEach(button=>button.disabled=true);sendButton.disabled=true;sendButton.textContent='发送中…';message.textContent='';const idKey=composeForm.dataset.key||crypto.randomUUID();composeForm.dataset.key=idKey;try{const attachments=await Promise.all(files.map(file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({filename:file.name,content:reader.result.split(',')[1],type:file.type});reader.onerror=reject;reader.readAsDataURL(file)})));const response=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':idKey},body:JSON.stringify({to:toInput.value,cc:ccInput.value,bcc:bccInput.value,fromPrefix:fromPrefixInput.value,fromName:fromNameInput.value,replyTo:replyToInput.value,subject:subjectInput.value,text:textInput.value,html:htmlInput.value,attachments})});message.textContent=response.ok?'发送成功':await readError(response);if(response.ok)delete composeForm.dataset.key}catch{message.textContent='网络错误，请稍后重试'}finally{sending=false;filesInput.disabled=false;chooseFiles.disabled=false;fileNames.querySelectorAll('button').forEach(button=>button.disabled=false);sendButton.disabled=false;sendButton.textContent='发送'}});logoutButton.addEventListener('click',async()=>{await fetch('/logout',{method:'POST',headers:{'X-CSRF-Token':csrf}});location='/login'});</script></body></html>`;
}
function css() {
  return `*,*::before,*::after{box-sizing:border-box}:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f3f6fb}body{margin:0;min-width:0;overflow-wrap:anywhere}main{min-height:100vh;min-height:100svh;min-height:100dvh;display:grid;place-items:center;padding:max(1rem,env(safe-area-inset-top)) max(1rem,env(safe-area-inset-right)) max(1rem,env(safe-area-inset-bottom)) max(1rem,env(safe-area-inset-left))}section{background:#fff;padding:clamp(1rem,4vw,2rem);border-radius:16px;box-shadow:0 8px 35px #17203318;width:min(100%,600px);min-width:0}h1{margin:0 0 .75rem;overflow-wrap:anywhere}.field{min-width:0}label{display:block;margin:.65rem 0 .2rem;font-weight:600}input,textarea,button{display:block;width:100%;min-height:44px;padding:.7rem .8rem;margin:.3rem 0;border:1px solid #ccd4e0;border-radius:8px;font:inherit;font-size:16px;line-height:1.35}.file-picker{display:flex;align-items:center;gap:12px;min-width:0;padding:6px;border:1px solid #ccd4e0;border-radius:8px;margin:.3rem 0;font-size:16px;line-height:24px}.file-picker input[hidden]{display:none}#chooseFiles{display:flex;align-items:center;justify-content:center;flex:0 0 auto;width:auto;height:44px;min-height:44px;padding:0 14px;margin:0;border:1px solid #ccd4e0;border-radius:6px;background:#f3f6fb;color:#172033;font:inherit}#chooseFiles span{display:block;line-height:24px}#fileStatus{display:flex;align-items:center;flex:1;min-width:0;color:#5e6b7e}#fileStatusText{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:24px}#login button[type=submit]{margin-top:1rem}textarea{min-height:110px;resize:vertical}button{background:#2563eb;color:#fff;border:0;cursor:pointer;touch-action:manipulation}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}button:disabled{opacity:.6;cursor:wait}header{display:flex;gap:1rem;justify-content:space-between;align-items:center}header h1{min-width:0}header button{width:auto;flex:0 0 auto;padding:.6rem .8rem}.hint,output,.file-names{display:block;color:#5e6b7e;margin:.6rem 0;overflow-wrap:anywhere}.file-names{min-height:1.35em}.file-item{display:flex;align-items:center;gap:.5rem;background:#f3f6fb;border:1px solid #e3e9f2;border-radius:8px;padding:.15rem .35rem .15rem .7rem;margin:.4rem 0}.file-item span{flex:1;min-width:0;overflow-wrap:anywhere}.file-remove{flex:0 0 44px;width:44px;min-height:44px;margin:0;padding:0;background:transparent;color:#5e6b7e;border-radius:8px;font-size:22px;line-height:1}.file-remove:hover:not(:disabled){background:#feecec;color:#b42318}.breakable{overflow-wrap:anywhere}.domain-warning{color:#b42318;font-weight:600}@media (max-width:480px){section{border-radius:12px}header{align-items:flex-start}header button{min-width:44px}}@media (min-width:700px){main{padding:max(2rem,env(safe-area-inset-top)) max(2rem,env(safe-area-inset-right)) max(2rem,env(safe-area-inset-bottom)) max(2rem,env(safe-area-inset-left))}}`;
}
