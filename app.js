(() => {
  "use strict";
  const cfg = window.APP_CONFIG || {};
  const configured = cfg.supabaseUrl && !cfg.supabaseUrl.startsWith("__") && cfg.supabaseAnonKey && !cfg.supabaseAnonKey.startsWith("__");
  const rememberFlagKey = "account-share-remember-login";
  const rememberUntilKey = "account-share-remember-until";
  const rememberedUntilAtLoad = Number(localStorage.getItem(rememberUntilKey) || 0);
  const rememberExpiredAtLoad = localStorage.getItem(rememberFlagKey) === "1" && rememberedUntilAtLoad <= Date.now();
  const authStorageKey = configured ? `sb-${new URL(cfg.supabaseUrl).hostname.split(".")[0]}-auth-token` : "";
  if (rememberExpiredAtLoad) {
    localStorage.removeItem(rememberFlagKey); localStorage.removeItem(rememberUntilKey);
    if (authStorageKey) { localStorage.removeItem(authStorageKey); sessionStorage.removeItem(authStorageKey); }
  }
  const rememberActive = () => localStorage.getItem(rememberFlagKey) === "1" && Number(localStorage.getItem(rememberUntilKey) || 0) > Date.now();
  const authStorage = {
    getItem(key) {
      if (rememberActive()) return localStorage.getItem(key) || sessionStorage.getItem(key);
      const current = sessionStorage.getItem(key), legacy = localStorage.getItem(key);
      if (current) return current;
      if (legacy) { sessionStorage.setItem(key, legacy); localStorage.removeItem(key); return legacy; }
      return null;
    },
    setItem(key, value) {
      if (rememberActive()) { localStorage.setItem(key, value); sessionStorage.removeItem(key); }
      else { sessionStorage.setItem(key, value); localStorage.removeItem(key); }
    },
    removeItem(key) { localStorage.removeItem(key); sessionStorage.removeItem(key); }
  };
  const client = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth:{ storage:authStorage, persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } }) : null;
  const $ = (id) => document.getElementById(id);
  const loginAliases = { admin:"admin@account-share.internal", user:"user@account-share.internal" };
  const state = { session: null, profile: null, accounts: [], selectedId: "", search: "", visiblePassword: false };

  const loginView = $("login-view"), appView = $("app-view"), workspace = $("workspace"), pendingView = $("pending-view");
  const authForm = $("login-form"), authMessage = $("auth-message"), content = $("content"), accountList = $("account-list");

  function showError(message) {
    const banner = $("error-banner");
    banner.querySelector("span").textContent = message || "操作失败，请稍后再试。";
    banner.classList.remove("hidden");
  }
  function toast(message) {
    const el = $("toast"); el.textContent = `✓ ${message}`; el.classList.remove("hidden");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add("hidden"), 2400);
  }
  function messageOf(error) { return error?.message || "操作失败，请稍后再试。"; }
  function esc(value) { return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
  function isAdmin() { return state.profile?.role === "admin"; }
  function selected() { return state.accounts.find(x => x.id === state.selectedId) || null; }
  function applyRememberPreference(enabled) {
    if (enabled) {
      localStorage.setItem(rememberFlagKey, "1");
      localStorage.setItem(rememberUntilKey, String(Date.now() + 30 * 24 * 60 * 60 * 1000));
    } else {
      localStorage.removeItem(rememberFlagKey); localStorage.removeItem(rememberUntilKey);
    }
  }

  async function initialize() {
    if (!client) {
      authMessage.textContent = "云数据库尚未完成配置，请联系管理员。";
      authForm.querySelectorAll("input,button").forEach(el => el.disabled = true);
      return;
    }
    const { data } = await client.auth.getSession();
    await handleSession(data.session);
    client.auth.onAuthStateChange((_event, session) => setTimeout(() => handleSession(session), 0));
  }

  async function handleSession(session) {
    state.session = session;
    if (!session) {
      state.profile = null; state.accounts = [];
      loginView.classList.remove("hidden"); appView.classList.add("hidden");
      return;
    }
    loginView.classList.add("hidden"); appView.classList.remove("hidden");
    try {
      let result = await client.from("profiles").select("id,email,display_name,role,approved,created_at").eq("id", session.user.id).maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) { await new Promise(r => setTimeout(r, 800)); result = await client.from("profiles").select("id,email,display_name,role,approved,created_at").eq("id", session.user.id).single(); }
      if (result.error) throw result.error;
      state.profile = result.data;
      $("user-chip").innerHTML = `<span class="presence"></span>${esc(result.data.display_name || result.data.email)} · ${result.data.role === "admin" ? "管理员" : "普通用户"}`;
      $("members-button").classList.toggle("hidden", !isAdmin());
      $("add-button").classList.toggle("hidden", !isAdmin());
      if (!result.data.approved) {
        workspace.classList.add("hidden"); pendingView.classList.remove("hidden"); return;
      }
      pendingView.classList.add("hidden"); workspace.classList.remove("hidden");
      await loadAccounts();
    } catch (error) { showError(messageOf(error)); }
  }

  async function loadAccounts(silent = false) {
    if (!silent) content.innerHTML = `<div class="panel empty-card"><p>正在加载共享资料…</p></div>`;
    const { data, error } = await client.from("accounts").select("id,label,login_account,account_password,mailbox_url,verification_email,quota_status,quota_refresh_at,notes,sort_order,updated_at,updated_by_profile:profiles!accounts_updated_by_fkey(display_name,email)").eq("active", true).order("sort_order").order("label");
    if (error) { showError(messageOf(error)); return; }
    state.accounts = data || [];
    if (!state.accounts.some(x => x.id === state.selectedId)) state.selectedId = state.accounts[0]?.id || "";
    render();
  }

  function render() {
    const query = state.search.trim().toLowerCase();
    const filtered = query ? state.accounts.filter(x => `${x.label} ${x.login_account}`.toLowerCase().includes(query)) : state.accounts;
    $("account-count").textContent = state.accounts.length;
    accountList.innerHTML = filtered.length ? filtered.map((item, i) => `<button class="account-item ${item.id === state.selectedId ? "active" : ""}" data-id="${item.id}"><span class="avatar ${statusTone(item.quota_status)}">${String(i + 1).padStart(2,"0")}</span><span><strong>${esc(item.label)}</strong><small>${esc(item.quota_status)}${item.quota_refresh_at ? ` · ${esc(shortTime(item.quota_refresh_at))}` : ""}</small></span></button>`).join("") : `<p class="list-empty">${state.accounts.length ? "没有匹配的账号" : "还没有共享账号"}</p>`;
    accountList.querySelectorAll("[data-id]").forEach(btn => btn.onclick = () => { state.selectedId = btn.dataset.id; state.visiblePassword = false; render(); });
    renderDetail();
  }

  function renderDetail() {
    const item = selected();
    if (!item) { content.innerHTML = `<div class="panel empty-card"><span>＋</span><h2>还没有共享账号</h2><p>${isAdmin() ? "点击左侧“新增账号”录入第一条资料。" : "请联系管理员添加账号资料。"}</p></div>`; return; }
    const updater = item.updated_by_profile?.display_name || item.updated_by_profile?.email || "未知用户";
    content.innerHTML = `<div class="detail-head"><div><span class="eyebrow">账号详情</span><h2>${esc(item.label)}</h2><p>最近更新：${esc(formatDate(item.updated_at))} · ${esc(updater)}</p></div>${isAdmin()?`<div class="detail-actions"><button id="edit-button" class="button ghost">编辑资料</button><button id="disable-button" class="button danger">停用</button></div>`:""}</div>
      <section class="panel credentials"><div class="section-title"><div><span class="section-icon">钥</span><div><h3>登录与验证</h3><p>敏感内容默认隐藏，按需复制</p></div></div><span class="secure-chip">仅批准成员可见</span></div><div class="field-grid">
      ${field("登录账号", item.login_account, "login")}${field("账号密码", state.visiblePassword ? item.account_password : (item.account_password ? "••••••••••••••" : "未填写"), "password", true)}${field("邮箱入口", item.mailbox_url || "未填写", "mailbox")}${field("自助验证邮箱", item.verification_email || "未填写", "verification")}</div></section>
      <section class="panel quota-card"><div class="quota-copy"><span class="section-icon mint">时</span><div><h3>额度与更新时间</h3><p>管理员与普通成员都可以更新此区域</p></div></div><div class="quota-form"><label><span>额度状态</span><select id="quota-status">${["可用","额度不足","等待刷新","暂停使用"].map(v=>`<option ${v===item.quota_status?"selected":""}>${v}</option>`).join("")}</select></label><label><span>预计刷新时间（北京时间）</span><input id="quota-time" type="datetime-local" value="${esc(toBeijingInput(item.quota_refresh_at))}"></label><button id="quota-save" class="button">保存更新</button></div></section>
      ${item.notes?`<section class="panel notes-card"><span>备注</span><p>${esc(item.notes)}</p></section>`:""}<section class="notice"><span>i</span><p><strong>权限说明</strong>普通成员只能查看、复制并更新额度时间；账号名称、密码和邮箱资料仅管理员可以修改。</p></section>`;
    content.querySelectorAll("[data-copy]").forEach(btn => btn.onclick = () => copyValue(copySource(btn.dataset.copy, item), btn.dataset.label));
    const show = $("show-password"); if (show) show.onclick = () => { state.visiblePassword = !state.visiblePassword; renderDetail(); };
    if (isAdmin()) { $("edit-button").onclick = () => openAccountModal(item); $("disable-button").onclick = disableAccount; }
    $("quota-save").onclick = saveQuota;
  }

  function field(label, value, source, password = false) { return `<div class="field"><span>${label}</span><div><code title="${esc(value)}">${esc(value)}</code>${password?`<button id="show-password" class="show-button">${state.visiblePassword?"隐藏":"显示"}</button>`:""}<button class="copy-button" data-copy="${source}" data-label="${label}">复制</button></div></div>`; }
  function copySource(source, item) { return ({login:item.login_account,password:item.account_password,mailbox:item.mailbox_url,verification:item.verification_email})[source] || ""; }
  async function copyValue(value, label) { if (!value) return; try { await navigator.clipboard.writeText(value); toast(`${label}已复制`); } catch { showError("浏览器未允许复制，请手动选择文字复制。"); } }

  function openAccountModal(item = null) {
    $("account-modal-title").textContent = item ? "编辑账号资料" : "新增共享账号";
    $("edit-id").value = item?.id || ""; $("edit-label").value = item?.label || ""; $("edit-login").value = item?.login_account || ""; $("edit-password").value = item?.account_password || ""; $("edit-mailbox").value = item?.mailbox_url || ""; $("edit-verification").value = item?.verification_email || ""; $("edit-notes").value = item?.notes || ""; $("edit-sort").value = item?.sort_order ?? 10;
    $("account-modal").classList.remove("hidden");
  }
  async function saveAccount(event) {
    event.preventDefault();
    const payload = { id: $("edit-id").value || null, label: $("edit-label").value.trim(), login_account: $("edit-login").value.trim(), account_password: $("edit-password").value, mailbox_url: $("edit-mailbox").value.trim(), verification_email: $("edit-verification").value.trim(), notes: $("edit-notes").value.trim(), sort_order: Number($("edit-sort").value)||10 };
    const { data, error } = await client.rpc("save_account", { p_account: payload });
    if (error) return showError(messageOf(error));
    $("account-modal").classList.add("hidden"); state.selectedId = data; await loadAccounts(true); toast("账号资料已保存");
  }
  async function disableAccount() {
    const item = selected(); if (!item || !confirm(`确认停用“${item.label}”？停用后不再显示，但不会删除历史记录。`)) return;
    const { error } = await client.rpc("disable_account", { p_id: item.id }); if (error) return showError(messageOf(error));
    state.selectedId = ""; await loadAccounts(true); toast("账号已停用");
  }
  async function saveQuota() {
    const item = selected(); if (!item) return;
    const local = $("quota-time").value;
    const { error } = await client.rpc("update_quota", { p_id:item.id, p_status:$("quota-status").value, p_refresh_at:local ? new Date(local).toISOString() : null });
    if (error) return showError(messageOf(error)); await loadAccounts(true); toast("额度信息已同步");
  }
  async function openMembers() {
    const { data, error } = await client.from("profiles").select("id,email,display_name,role,approved,created_at").order("created_at");
    if (error) return showError(messageOf(error));
    $("member-list").innerHTML = data.map(user => `<div class="user-row"><div class="member-avatar">${esc((user.display_name||user.email).slice(0,1).toUpperCase())}</div><div class="member-name"><strong>${esc(user.display_name||user.email)}</strong><small>${esc(user.email)}</small></div><select data-role="${user.id}" ${user.id===state.profile.id?"disabled":""}><option value="user" ${user.role==="user"?"selected":""}>普通用户</option><option value="admin" ${user.role==="admin"?"selected":""}>管理员</option></select><label class="approval"><input type="checkbox" data-approved="${user.id}" ${user.approved?"checked":""} ${user.id===state.profile.id?"disabled":""}> 已批准</label></div>`).join("");
    $("member-list").querySelectorAll("select,input[type=checkbox]").forEach(el => el.onchange = async () => {
      const id = el.dataset.role || el.dataset.approved; const row = data.find(x=>x.id===id);
      const role = $("member-list").querySelector(`[data-role="${id}"]`).value; const approved = $("member-list").querySelector(`[data-approved="${id}"]`).checked;
      const { error } = await client.rpc("set_member_access", { p_user_id:id, p_role:role, p_approved:approved });
      if (error) { el.value = row.role; el.checked = row.approved; return showError(messageOf(error)); } toast("成员权限已更新");
    });
    $("members-modal").classList.remove("hidden");
  }

  authForm.onsubmit = async (event) => {
    event.preventDefault(); authMessage.textContent = "处理中…";
    const loginName = $("auth-login").value.trim().toLowerCase();
    const email = loginAliases[loginName];
    if (!email) { authMessage.textContent = "账号不存在，请输入 admin 或 user。"; return; }
    applyRememberPreference($("remember-login").checked);
    const result = await client.auth.signInWithPassword({ email, password:$("auth-password").value });
    authMessage.textContent = result.error ? "账号或密码错误。" : "登录成功。";
  };
  $("remember-login").checked = rememberActive();
  $("refresh-button").onclick = () => handleSession(state.session); $("signout-button").onclick = () => { applyRememberPreference(false); $("remember-login").checked = false; client.auth.signOut(); };
  $("members-button").onclick = openMembers; $("add-button").onclick = () => openAccountModal(); $("account-form").onsubmit = saveAccount;
  $("search-input").oninput = e => { state.search = e.target.value; render(); }; $("error-banner").querySelector("button").onclick = () => $("error-banner").classList.add("hidden");
  document.querySelectorAll("[data-close]").forEach(btn => btn.onclick = () => $(btn.dataset.close).classList.add("hidden"));

  function formatDate(value){try{return new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(value))}catch{return value||"未知时间"}}
  function shortTime(value){try{return new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(value))}catch{return value}}
  function toBeijingInput(value){if(!value)return"";try{return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(value)).replace(" ","T")}catch{return""}}
  function statusTone(status){return status==="可用"?"":status==="额度不足"||status==="等待刷新"?"amber":"gray"}
  initialize();
})();
