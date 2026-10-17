"use strict";

/* =====================================
   STATE & HELPERS
===================================== */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// Path to the API, relative to the dashboard page (eighteen_drafts/)
const API_URL = "api/transactions.php";
const POLL_MS = 2000;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"];
// transaction statuses that don't count towards income / expenses
// (a pending withdrawal only counts once you approve it)
const IGNORED = ["pending", "rejected", "declined", "cancelled", "failed", "expired"];

// database status words -> the four the withdrawal screen understands
const STATUS_MAP = { pending: "pending", approved: "approved", completed: "approved",
                     rejected: "rejected", declined: "rejected", cancelled: "rejected",
                     failed: "rejected", expired: "expired" };

// choices shown when you reject
const REASONS = ["It wasn't me", "Not right now", "Amount is too high", "Something else"];


let DB = { user: {}, settings: {}, categories: [], transactions: [], goals: [], notifications: [], withdrawals: [] };
const S = { month: "", filter: "all", query: "" };

const money = n => (DB.settings.currency_symbol || "₱") +
    Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = n => String(n).padStart(2, "0");
const toDate = v => new Date(String(v).replace(" ", "T"));
const monthKey = d => d.getFullYear() + "-" + pad(d.getMonth() + 1);
const monthLabel = k => MONTHS[+k.slice(5) - 1] + " " + k.slice(0, 4);
const shiftMonth = (k, n) => { const d = new Date(+k.slice(0, 4), +k.slice(5) - 1 + n, 1); return monthKey(d); };

// The API does not send categories yet, so unknown ones fall back by type.
const getCat = (id, type) => DB.categories.find(c => c.category_id == id) ||
    (type === "income"
        ? { name: "Deposit", color_hex: "#12915F", icon: "💰", type: "income" }
        : { name: "Withdraw", color_hex: "#F44F1D", icon: "🐷", type: "expense" });

const inMonth = k => DB.transactions.filter(t => monthKey(t.date) === k && !IGNORED.includes(t.status));
const total = (list, type) => list.filter(t => t.type === type).reduce((s, t) => s + t.amount, 0);
const is12h = () => (DB.settings.time_format || "12h") === "12h";

function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2200);
}

function progress(pct, cls) {
    return `<div class="bar"><i class="${cls || (pct > 100 ? "over" : pct > 80 ? "warn" : "")}" style="width:${Math.min(pct, 100)}%"></i></div>`;
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}


/* =====================================
   API
===================================== */

async function apiPost(payload) {
    const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON response */ }
    if (res.status === 401) location.href = "Login.php";                // signed out
    if (!res.ok) {
        const err = new Error(data.error || "Server error (" + res.status + ")");
        err.status = res.status;
        throw err;
    }
    return data;
}

// The database may return type/status in any letter case, so compare lowercase.
const kind = v => String(v == null ? "" : v).trim().toLowerCase();
const isDeposit = v => ["deposit", "income"].includes(kind(v));
const isWithdraw = v => ["withdraw", "withdrawal", "expense"].includes(kind(v));

let lastSig = "";
let offlineShown = false;

// Reads all transactions. Only re-renders when something actually changed.
let lastErr = "";

async function loadData() {
    let rows, cats, settings;

    // 1) talk to the server
    try {
        const res = await fetch(API_URL, { cache: "no-store" });
        if (res.status === 401) { location.href = "Login.php"; return; }   // signed out
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        rows = json.transactions || [];
        cats = json.categories || [];
        settings = json.settings || {};
        offlineShown = false;
    } catch (e) {
        console.error("API error:", e);
        if (!offlineShown) { toast("Can't reach the server"); offlineShown = true; }
        return;
    }

    // age_seconds changes every second, so leave it out of the comparison
    const sig = JSON.stringify([rows.map(({ age_seconds, ...r }) => r), cats, settings]);
    if (sig === lastSig) return;

    // 2) draw the page (errors here are shown as what they really are)
    try {
        applyRows(rows, cats, settings);
        lastSig = sig;
        lastErr = "";
    } catch (e) {
        console.error("Dashboard error:", e);
        if (lastErr !== e.message) { toast("Dashboard error: " + e.message); lastErr = e.message; }
    }
}

function applyRows(rows, cats, settings) {
    // saved settings from the server (applied first: the countdown uses them)
    const wait = parseInt(settings && settings.withdrawal_approval_seconds, 10);
    if (wait > 0) DB.settings.withdrawal_approval_seconds = wait;

    // accepts a few common column names, in case your categories table names them differently
    DB.categories = (cats || []).map(c => ({
        category_id: c.category_id,
        name: c.name || c.category_name || c.title || "Category",
        type: isDeposit(c.type) ? "income" : "expense",
        color_hex: c.color_hex || c.color || "#20243A",
        icon: c.icon || c.emoji || "💸"
    }));

    DB.transactions = rows.map(r => ({
        transaction_id: r.transaction_id,
        category_id: r.category_id,
        type: isDeposit(r.type) ? "income" : "expense",
        amount: +r.amount,
        note: r.note || "",
        source: r.source,
        status: kind(r.status),
        cancel_reason: r.cancel_reason,
        transaction_date: r.transaction_date,
        date: toDate(r.transaction_date)
    }));

    DB.withdrawals = rows.filter(r => isWithdraw(r.type)).map(r => {
        const id = String(r.transaction_id);
        const at = toDate(r.created_at || r.transaction_date);

        const raw = kind(r.status);
        let status = STATUS_MAP[raw] || raw;
        if (raw === "cancelled" && r.cancel_reason === "Expired") status = "expired";

        // Work out the deadline once. age_seconds comes from the server's own clock.
        // Without it, the window starts the moment this page first sees the request,
        // so a time zone difference can never make a new request look already expired.
        if (!WD.exp[id]) {
            const age = r.age_seconds != null ? Math.max(0, +r.age_seconds) : 0;
            WD.exp[id] = Date.now() + (wdWait() - age) * 1000;
        }

        return {
            transaction_id: r.transaction_id,
            amount: +r.amount,
            note: r.note || "",
            status,
            cancel_reason: status === "rejected" ? r.cancel_reason : null,
            at,
            expMs: WD.exp[id]
        };
    });

    // requests that already ran out of time while nobody was looking
    DB.withdrawals.filter(w => w.status === "pending" && secsLeft(w) <= 0).forEach(expireWithdrawal);

    const keep = S.month;
    fillMonths();
    S.month = keep;
    $("#month").value = keep;

    // a drawing problem must never stop the pop-up from opening
    try { render(); } catch (e) { console.error("Render error:", e); toast("Display error: " + e.message); }
    checkIncoming();

    // if the open sheet is still asking but the request was decided elsewhere
    if (sheetOpen() && (WD.view === "ask" || WD.view === "reason")) {
        const c = wdCur();
        if (c && c.status !== "pending") { WD.view = c.status; drawSheet(); }
    }
}


/* =====================================
   NAVIGATION
===================================== */

const ICONS = {
    home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    charts: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    goals: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
    me: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>'
};
const LABELS = { home: "Home", charts: "Charts", goals: "Goals", me: "Profile" };

$$(".nav button").forEach(b => {
    b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[b.dataset.t]}</svg>${LABELS[b.dataset.t]}`;
    b.onclick = () => goTo(b.dataset.t);
});

function goTo(tab) {
    $$(".tab").forEach(x => x.classList.toggle("on", x.id === tab));
    $$(".nav button").forEach(b => b.classList.toggle("on", b.dataset.t === tab));
    render();
    window.scrollTo(0, 0);
}

function activeTab() { return $(".tab.on").id; }


/* =====================================
   RENDER
===================================== */

function render() {
    const tab = activeTab();
    renderWithdrawals();
    if (tab === "home") renderHome();
    if (tab === "charts") renderCharts();
    if (tab === "goals") renderGoals();
    if (tab === "me") renderProfile();
}

function budgetSummary() {
    const spent = total(inMonth(S.month), "expense");
    const budget = +DB.settings.monthly_budget || 0;
    const pct = budget ? Math.round(spent / budget * 100) : 0;
    return { spent, budget, pct, left: budget - spent };
}

function renderHome() {
    const h = new Date().getHours();
    const first = (DB.user.full_name || "").split(" ")[0];
    $("#hi").textContent = (h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening") +
        (first ? ", " + first : "") + " 👋";

    const all = inMonth(S.month), inc = total(all, "income"), exp = total(all, "expense");
    $("#sBal").textContent = money(inc - exp);
    $("#sInc").textContent = money(inc);
    $("#sExp").textContent = money(exp);

    const b = budgetSummary();
    $("#budgetCard").innerHTML = b.budget
        ? `<div class="top nomb"><h2>Monthly budget</h2><b>${b.pct}%</b></div>${progress(b.pct)}
           <p class="sub">${b.left >= 0
                ? `You have <b>${money(b.left)}</b> left of ${money(b.budget)}.`
                : `You're <b>${money(-b.left)}</b> over your ${money(b.budget)} budget.`}</p>`
        : `<h2>Monthly budget</h2><p class="sub">No budget set yet. Set one in the Goals tab.</p>`;

    const rows = all
        .filter(t => (S.filter === "all" || t.type === S.filter) &&
                     (t.note + " " + getCat(t.category_id, t.type).name).toLowerCase().includes(S.query))
        .sort((a, b) => b.date - a.date);

    let html = "", lastDay = "";
    rows.forEach(t => {
        const day = t.date.toDateString();
        if (day !== lastDay) {
            lastDay = day;
            html += `<div class="day">${t.date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</div>`;
        }
        const c = getCat(t.category_id, t.type);
        const time = t.date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: is12h() });
        html += `<div class="tx">
            <div class="ic" style="background:${c.color_hex}22">${c.icon}</div>
            <div class="m"><strong>${esc(t.note || c.name)}</strong>
                <small>${esc(DB.categories.some(x => x.category_id == t.category_id) ? c.name : "Uncategorized")} · ${time}</small></div>
            <div class="amt ${t.type === "income" ? "in" : "out"}">${t.type === "income" ? "+" : "−"}${money(t.amount)}</div>
            <button class="btn g" style="flex:none;white-space:nowrap" data-edit="${esc(t.transaction_id)}" aria-label="Edit transaction">✏️ Edit</button>
        </div>`;
    });
    $("#list").innerHTML = html || '<div class="empty">No transactions yet.</div>';
    $$("[data-edit]").forEach(b => b.onclick = () => openEdit(b.dataset.edit));
}


/* ---------- Charts ---------- */

function renderCharts() {
    $("#cSub").textContent = monthLabel(S.month);
    const exp = inMonth(S.month).filter(t => t.type === "expense");
    const sum = exp.reduce((s, t) => s + t.amount, 0);

    // Donut
    const byCat = {};
    exp.forEach(t => byCat[t.category_id] = (byCat[t.category_id] || 0) + t.amount);
    const parts = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    let offset = 0, arcs = "";
    parts.forEach(([id, v]) => {
        const len = v / sum * 100;
        arcs += `<circle r="15.9" cx="21" cy="21" fill="none" stroke="${getCat(id, "expense").color_hex}" stroke-width="6"
                 stroke-dasharray="${len} ${100 - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 21 21)"/>`;
        offset += len;
    });
    $("#donut").innerHTML = sum
        ? `<svg viewBox="0 0 42 42" style="max-width:230px;display:block;margin:10px auto">
             <circle r="15.9" cx="21" cy="21" fill="none" stroke="var(--line)" stroke-width="6"/>${arcs}
             <text x="21" y="20.5" text-anchor="middle" font-size="2.8" fill="var(--mute)">Spent</text>
             <text x="21" y="25" text-anchor="middle" font-size="3.2" font-weight="700" fill="var(--ink)">${money(sum).replace(/\.00$/, "")}</text></svg>
           <div class="legend">${parts.map(([id, v]) => `<span><i style="background:${getCat(id, "expense").color_hex}"></i>${esc(getCat(id, "expense").name)} · ${Math.round(v / sum * 100)}%</span>`).join("")}</div>`
        : '<div class="empty">No spending this month yet.</div>';

    // Daily bars
    const dim = new Date(+S.month.slice(0, 4), +S.month.slice(5), 0).getDate();
    const days = Array(dim).fill(0);
    exp.forEach(t => days[t.date.getDate() - 1] += t.amount);
    const max = Math.max(...days, 1);
    $("#daily").innerHTML = `<svg viewBox="0 0 ${dim * 10} 140" style="width:100%;margin-top:10px">
        ${days.map((v, i) => `<rect x="${i * 10 + 1}" y="${120 - v / max * 110}" width="8" height="${v / max * 110}" rx="3"
            fill="${v && v === max ? "var(--or)" : "#20243A"}" opacity="${v ? 1 : 0.15}"><title>Day ${i + 1}: ${money(v)}</title></rect>`).join("")}
        <text x="0" y="136" font-size="9" fill="var(--mute)">1</text>
        <text x="${dim * 10}" y="136" font-size="9" text-anchor="end" fill="var(--mute)">${dim}</text></svg>
        <p class="sub">Biggest day: ${sum ? money(max) : "-"}</p>`;

    // 5-month trend ending at the selected month
    const keys = [-4, -3, -2, -1, 0].map(n => shiftMonth(S.month, n));
    const data = keys.map(k => [k, total(inMonth(k), "income"), total(inMonth(k), "expense")]);
    const top = Math.max(...data.flatMap(d => [d[1], d[2]]), 1);
    $("#trend").innerHTML = `<svg viewBox="0 0 340 170" style="width:100%">
        ${data.map((d, i) => `
          <rect x="${i * 68 + 10}" y="${140 - d[1] / top * 125}" width="22" height="${d[1] / top * 125}" rx="5" fill="var(--inc)"/>
          <rect x="${i * 68 + 36}" y="${140 - d[2] / top * 125}" width="22" height="${d[2] / top * 125}" rx="5" fill="var(--exp)"/>
          <text x="${i * 68 + 34}" y="158" text-anchor="middle" font-size="11" fill="var(--mute)">${MONTHS[+d[0].slice(5) - 1].slice(0, 3)}</text>`).join("")}</svg>
        <div class="legend"><span><i style="background:var(--inc)"></i>Income</span><span><i style="background:var(--exp)"></i>Expenses</span></div>`;
}


/* ---------- Goals ---------- */

function renderGoals() {
    const b = budgetSummary();
    $("#budgetBig").innerHTML = `
        <h2>Monthly budget</h2><p class="sub">${monthLabel(S.month)} spending limit</p>
        <div class="big">${money(b.spent)} <small>of ${money(b.budget)}</small></div>
        ${progress(b.pct)}
        <p class="sub">${b.left >= 0 ? money(b.left) + " left to spend" : "Over budget by " + money(-b.left)}</p>
        <label class="sub" for="bi" style="display:block;margin-top:14px;font-weight:600">Change your limit</label>
        <div class="field-row"><input id="bi" class="search" type="number" min="0" value="${b.budget}"><button class="btn o" id="bs">Save</button></div>`;

    $("#bs").onclick = () => {
        DB.settings.monthly_budget = Math.max(0, +$("#bi").value || 0);
        toast("Budget saved");
        render();
    };

    $("#goalList").innerHTML = DB.goals.length ? DB.goals.map(g => {
        const pct = Math.round(g.saved_amount / g.target_amount * 100) || 0;
        const done = pct >= 100;
        return `<div class="goal">
            <div class="r"><b>${esc(g.goal_name)}</b><span class="sub">${done ? "✅ Reached" : (g.target_date ? toDate(g.target_date).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "No date")}</span></div>
            ${progress(pct, "goal")}
            <div class="r" style="margin-top:6px"><span class="sub">${money(g.saved_amount)} / ${money(g.target_amount)}</span>
            ${done ? "" : `<button class="btn g" data-g="${g.goal_id}">+ Add funds</button>`}</div></div>`;
    }).join("") : '<div class="empty">No goals yet.<br>Tap “+ New goal” to start saving.</div>';

    $$("[data-g]").forEach(btn => btn.onclick = () => {
        const g = DB.goals.find(x => x.goal_id == btn.dataset.g);
        openDialog("Add to “" + g.goal_name + "”",
            `<label for="ga">Amount</label><input id="ga" type="number" min="1" inputmode="decimal" placeholder="500">
             <button class="btn o full" id="gok">Add funds</button>`);
        $("#gok").onclick = () => {
            const amt = +$("#ga").value;
            if (!amt) return toast("Enter an amount first");
            g.saved_amount = +g.saved_amount + amt;
            $("#dlg").close();
            toast("Funds added");
            render();
        };
    });
}

$("#newGoal").onclick = () => {
    openDialog("New savings goal",
        `<label for="gn">Goal name</label><input id="gn" maxlength="100" placeholder="e.g. Headphones">
         <label for="gt">Target amount</label><input id="gt" type="number" min="1" inputmode="decimal">
         <button class="btn o full" id="gok">Create goal</button>`);
    $("#gok").onclick = () => {
        const name = $("#gn").value.trim(), target = +$("#gt").value;
        if (!name || !target) return toast("Add a name and a target");
        DB.goals.push({ goal_id: "new" + Date.now(), goal_name: name, target_amount: target, saved_amount: 0, target_date: null, status: "active" });
        $("#dlg").close();
        toast("Goal created");
        render();
    };
};


/* ---------- Profile ---------- */

function renderProfile() {
    const name = DB.user.full_name || "";
    $("#av").textContent = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    $("#nm").textContent = name;
    $("#em").textContent = DB.user.email || "";

    const s = DB.settings;
    $("#prefs").innerHTML = `
        <div class="row"><span>Currency</span><b>${esc(s.currency_symbol || "₱")}</b></div>
        <div class="row"><span>Time zone</span><b>${esc(s.timezone || "-")}</b></div>
        <div class="row"><span>Time format</span><button class="btn g" id="tf">${is12h() ? "12-hour" : "24-hour"}</button></div>
        <div class="row"><span>Low balance alert</span><b>Below ${money(s.low_balance_alert || 0)}</b></div>
        <div class="row"><span>Withdrawal approval wait</span><button class="btn g" id="waitBtn">⏱️ ${fmtSecs(wdWait())}</button></div>
        <div class="row"><span>Categories</span><button class="btn g" id="catBtn">🗂️ Manage</button></div>
        <div class="row"><span>Withdraw PIN</span><button class="btn g" id="pinBtn">🔒 Change</button></div>`;
    $("#catBtn").onclick = openCategories;
    $("#pinBtn").onclick = openPinEditor;
    $("#waitBtn").onclick = openWaitEditor;
    $("#tf").onclick = () => {
        s.time_format = is12h() ? "24h" : "12h";
        render();
    };

    $("#notes").innerHTML = DB.notifications.length ? DB.notifications.map(n =>
        `<div class="tx"><div class="ic" style="background:var(--line)">${n.is_read ? "✉️" : "🔔"}</div>
         <div class="m"><strong style="white-space:normal">${esc(n.message)}</strong>
         <small>${toDate(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small></div></div>`).join("")
        : '<div class="empty">You\'re all caught up.</div>';
}


/* =====================================
   DIALOG
===================================== */

function openDialog(title, body) {
    $("#dT").textContent = title;
    $("#dB").innerHTML = body;
    $("#dlg").showModal();
}

$("#dX").onclick = () => $("#dlg").close();
$("#dlg").onclick = e => { if (e.target.id === "dlg") e.target.close(); };


/* ---------- Edit a transaction (category + note only, never the amount) ---------- */

// styles for the category tiles (kept here so only this file needs replacing)
const editCss = document.createElement("style");
editCss.textContent = `
.cats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 6px; max-height: 240px; overflow-y: auto; padding: 2px; }
.cat { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
       padding: 10px 4px; border: 2px solid var(--line); border-radius: 14px; background: var(--card);
       font-size: 11px; font-weight: 600; line-height: 1.2; text-align: center; }
.cat span { font-size: 26px; line-height: 1; }
.cat.on { border-color: var(--or); background: rgba(244, 79, 29, 0.1); }
.emojis { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; max-height: 240px; overflow-y: auto; margin: 4px 0 10px; }
.emo { border: 0; background: transparent; font-size: 24px; line-height: 1; padding: 7px 0; border-radius: 10px; }
.emo:hover, .emo:active { background: var(--line); }
`;
document.head.appendChild(editCss);

function openEdit(id) {
    const t = DB.transactions.find(x => String(x.transaction_id) === String(id));
    if (!t) return;

    const cats = DB.categories.filter(c => c.type === t.type);
    const select = cats.length
        ? `<label>Category</label>
           <div class="cats">${cats.map(c =>
               `<button type="button" class="cat${String(c.category_id) === String(t.category_id) ? " on" : ""}" data-cat="${esc(c.category_id)}"><span>${esc(c.icon)}</span>${esc(c.name)}</button>`
           ).join("")}</div>`
        : `<p class="sub" style="margin-top:12px">No categories found yet, so only the note can be edited.</p>`;

    openDialog("Edit transaction",
        `<p class="sub">${t.type === "income" ? "Deposit" : "Withdrawal"} · ${money(t.amount)} (the amount can't be changed)</p>
         ${select}
         <label for="en">Note</label>
         <input id="en" maxlength="255" value="${esc(t.note)}" placeholder="What was this for?">
         <button class="btn o full" id="esave">Save changes</button>`);

    // tapping a tile selects that category
    let chosen = String(t.category_id);
    $$("#dB [data-cat]").forEach(b => b.onclick = () => {
        chosen = b.dataset.cat;
        $$("#dB [data-cat]").forEach(x => x.classList.toggle("on", x === b));
    });

    $("#esave").onclick = async () => {
        const btn = $("#esave");
        const note = $("#en").value.trim();
        const payload = { action: "update_transaction", transaction_id: t.transaction_id, note };
        if (cats.length && +chosen > 0) payload.category_id = +chosen;

        btn.disabled = true;
        try {
            await apiPost(payload);
            t.note = note;
            if (payload.category_id) t.category_id = payload.category_id;
            $("#dlg").close();
            toast("Saved");
            render();
            lastSig = "";          // pull the saved version from the server on the next poll
        } catch (err) {
            btn.disabled = false;
            toast(err.message || "Could not save");
        }
    };
}


/* ---------- Categories (Profile -> Categories): everything happens in pop-ups ---------- */

const CAT_COLORS = ["#F44F1D", "#F2A413", "#12915F", "#1E88E5", "#8E44AD", "#E91E63", "#795548", "#20243A"];
const CAT = { id: null, type: "income", icon: "🏷️", name: "", color: CAT_COLORS[0] };   // the form being edited

const EMOJI_GROUPS = [
    ["😀", "Faces", "😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 👽 🤖 🎃"],
    ["👋", "People", "👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 💪 🦾 🧠 👀 👁️ 👅 👄 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 👮 🕵️ 💂 👷 🤴 👸 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🧞 🧟 💃 🕺 👪 🏃 🚶 🧘"],
    ["🐶", "Animals & nature", "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🕷️ 🦂 🐢 🐍 🦎 🐙 🦑 🦐 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦚 🦜 🕊️ 🐇 🦝 🦨 🦡 🐁 🐀 🐿️ 🦔 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🍁 🍂 🍃 🌺 🌻 🌹 🌷 🌼 🌸 💐 🍄"],
    ["🍔", "Food & drink", "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🧀 🥚 🍳 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🍾 🧊 🥄 🍴 🍽️"],
    ["⚽", "Activities", "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🎱 🏓 🏸 🏒 🏏 ⛳ 🏹 🎣 🥊 🥋 🎽 ⛸️ 🛹 🛷 🎿 🏂 🏋️ 🤸 🤺 🏇 🧗 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🎫 🎟️ 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🕹️ 🎰 🧩"],
    ["🚗", "Travel & places", "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🚚 🚛 🚜 🛵 🏍️ 🚲 🛴 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🚢 ⚓ ⛽ 🚧 🚦 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🏠 🏡 🏘️ 🏢 🏬 🏣 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🌃 🌆 🌇 🌉 🌌 🌅 🌄"],
    ["💡", "Objects", "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📷 📸 📹 🎥 📞 ☎️ 📟 📠 📺 📻 🎙️ ⏰ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🧯 🛒 💰 💴 💵 💶 💷 💸 💳 🧾 💎 ⚖️ 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧰 🧲 🔫 💣 🔪 🛡️ 🔮 🧿 💈 🔭 🔬 🩹 🩺 💊 💉 🧬 🦠 🧪 🌡️ 🧹 🧺 🧻 🚽 🚿 🛁 🧼 🧽 🔑 🗝️ 🚪 🛋️ 🛏️ 🧸 🖼️ 🛍️ 🎁 🎈 🎀 🎊 🎉 ✉️ 📦 📫 📜 📃 📄 📊 📈 📉 📆 📅 📇 📋 📁 📂 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🏷️ 🔗 📎 📏 📐 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔒 🔓"],
    ["❤️", "Symbols", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ☮️ ✝️ ☪️ ☯️ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ⭐ 🌟 ✨ ⚡ 🔥 💥 ☄️ ☀️ 🌤️ ⛅ 🌥️ ☁️ 🌦️ 🌧️ ⛈️ 🌩️ 🌨️ ❄️ ☃️ ⛄ 🌬️ 💨 💧 💦 ☔ 🌈 🌙 🌚 🌝 🌞 🌍 🌎 🌏 🪐 ✅ ❌ ❓ ❗ ⭕ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔶 🔷 ➕ ➖ ➗ ✖️ ♾️ 💲 ™️ ©️ ®️ 🆕 🆓 🆒 🆗 🔝 🔜 ♻️ ⚜️ 🔱 📍 🚩 🏁 🏴 🏳️"]
];

// shows content inside the one shared pop-up (opens it only if it is closed)
function showView(title, html) {
    $("#dT").textContent = title;
    $("#dB").innerHTML = html;
    if (!$("#dlg").open) $("#dlg").showModal();
}

// first emoji of whatever was typed or pasted
function firstEmoji(s) {
    s = String(s || "").trim();
    try { return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)][0].segment; }
    catch (e) { return Array.from(s)[0] || ""; }
}

// 45 -> "45 seconds", 120 -> "2 min", 90 -> "1 min 30 s"
const fmtSecs = n => n < 60 ? n + " seconds"
    : (n % 60 ? Math.floor(n / 60) + " min " + (n % 60) + " s" : (n / 60) + " min");

// Profile -> Withdrawal approval wait
function openWaitEditor() {
    const cur = wdWait();
    const presets = [15, 30, 60, 120, 300];

    showView("Approval wait", `
        <p class="sub">How long you have to approve or reject a withdrawal before it expires on its own. It applies to new requests.</p>
        <label>Quick choices</label>
        <div class="chips" style="margin:6px 0">${presets.map(p =>
            `<button type="button" class="chip${p === cur ? " on" : ""}" data-w="${p}">${fmtSecs(p)}</button>`
        ).join("")}</div>
        <label for="wsec">Or type your own (10 to 300 seconds)</label>
        <input id="wsec" type="number" min="10" max="300" inputmode="numeric" value="${cur}">
        <button class="btn o full" id="wsave">Save</button>`);

    const mark = () => $$("#dB [data-w]").forEach(x => x.classList.toggle("on", +x.dataset.w === +$("#wsec").value));

    $$("#dB [data-w]").forEach(b => b.onclick = () => { $("#wsec").value = b.dataset.w; mark(); });
    $("#wsec").oninput = mark;

    $("#wsave").onclick = async () => {
        const n = parseInt($("#wsec").value, 10);
        if (!(n >= 10 && n <= 300)) return toast("Enter 10 to 300 seconds");

        const btn = $("#wsave");
        btn.disabled = true;
        try {
            await apiPost({ action: "update_setting", key: "withdrawal_approval_seconds", value: n });
            DB.settings.withdrawal_approval_seconds = n;
            $("#dlg").close();
            toast("Approval wait saved");
            render();
        } catch (err) {
            btn.disabled = false;
            toast(err.message || "Could not save");
        }
    };
}

// Profile -> Withdraw PIN (the PIN the piggy bank keypad asks for)
function openPinEditor() {
    showView("Change PIN", `
        <p class="sub">The PIN the piggy bank asks for before a withdrawal. Use 4 to 8 digits.</p>
        <label for="pinCur">Current PIN</label>
        <input id="pinCur" type="password" inputmode="numeric" autocomplete="off" maxlength="8">
        <label for="pinNew">New PIN</label>
        <input id="pinNew" type="password" inputmode="numeric" autocomplete="off" maxlength="8">
        <label for="pinNew2">Confirm new PIN</label>
        <input id="pinNew2" type="password" inputmode="numeric" autocomplete="off" maxlength="8">
        <button class="btn o full" id="pinSave">Save PIN</button>`);

    // digits only
    $$("#dB input").forEach(i => i.oninput = () => { i.value = i.value.replace(/\D/g, ""); });

    $("#pinSave").onclick = async () => {
        const cur = $("#pinCur").value, nw = $("#pinNew").value, nw2 = $("#pinNew2").value;
        if (!cur) return toast("Enter your current PIN");
        if (!/^\d{4,8}$/.test(nw)) return toast("The new PIN must be 4 to 8 digits");
        if (nw !== nw2) return toast("The new PINs don't match");

        const btn = $("#pinSave");
        btn.disabled = true;
        try {
            await apiPost({ action: "change_pin", current_pin: cur, new_pin: nw });
            $("#dlg").close();
            toast("PIN changed");
        } catch (err) {
            btn.disabled = false;
            toast(err.message || "Could not change the PIN");
        }
    };
}

function openCategories() { catList(); }

// 1) the list
function catList() {
    const block = (type, label) => {
        const cs = DB.categories.filter(c => c.type === type);
        return `<label>${label}</label>
            <div class="cats">${cs.map(c =>
                `<button type="button" class="cat" data-ce="${esc(c.category_id)}"><span>${esc(c.icon)}</span>${esc(c.name)}</button>`
            ).join("") || '<p class="sub" style="grid-column:1/-1">None yet.</p>'}</div>`;
    };
    showView("Categories", `
        <p class="sub">Tap a category to edit it.</p>
        ${block("income", "Deposits")}
        ${block("expense", "Withdrawals")}
        <button class="btn o full" id="catNew">+ New category</button>`);

    $$("#dB [data-ce]").forEach(b => b.onclick = () => catForm(b.dataset.ce));
    $("#catNew").onclick = () => catForm(null);
}

// 2) new / edit form  (keepDraft = come back from the emoji picker without losing what was typed)
function catForm(id, keepDraft) {
    if (!keepDraft) {
        const c = id ? DB.categories.find(x => String(x.category_id) === String(id)) : null;
        CAT.id = c ? c.category_id : null;
        CAT.type = c ? c.type : "income";
        CAT.icon = c ? c.icon : "🏷️";
        CAT.name = c ? c.name : "";
        CAT.color = c ? c.color_hex : CAT_COLORS[0];
    }
    const editing = CAT.id != null;

    const swatches = CAT_COLORS.map(col =>
        `<button type="button" data-cc="${col}" aria-label="Color ${col}"
            style="width:34px;height:34px;border-radius:50%;background:${col};border:3px solid ${col === CAT.color ? "var(--ink)" : "transparent"}"></button>`
    ).join("");

    showView(editing ? "Edit category" : "New category", `
        <div style="text-align:center;margin:10px 0 2px">
            <button type="button" class="cat on" id="cIcon" aria-label="Choose an emoji" style="width:110px;margin:0 auto">
                <span style="font-size:46px">${esc(CAT.icon)}</span>Tap to change</button>
        </div>
        <label for="cn">Name</label>
        <input id="cn" maxlength="40" value="${esc(CAT.name)}" placeholder="e.g. Snacks">
        ${editing ? "" : `<label>Type</label>
            <div class="seg">
                <button type="button" class="chip${CAT.type === "income" ? " on" : ""}" data-ct="income">💰 Deposit</button>
                <button type="button" class="chip${CAT.type === "expense" ? " on" : ""}" data-ct="expense">🛒 Withdrawal</button>
            </div>`}
        <label>Color</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">${swatches}</div>
        <div class="btns" style="margin-top:20px">
            <button class="btn g full" id="cBack">Back</button>
            <button class="btn o full" id="cSave">Save</button>
        </div>`);

    $("#cn").oninput = e => { CAT.name = e.target.value; };
    $("#cIcon").onclick = () => emojiPicker(0);
    $("#cBack").onclick = catList;

    $$("#dB [data-ct]").forEach(b => b.onclick = () => {
        CAT.type = b.dataset.ct;
        $$("#dB [data-ct]").forEach(x => x.classList.toggle("on", x === b));
    });

    $$("#dB [data-cc]").forEach(b => b.onclick = () => {
        CAT.color = b.dataset.cc;
        $$("#dB [data-cc]").forEach(x => x.style.borderColor = x === b ? "var(--ink)" : "transparent");
    });

    $("#cSave").onclick = async () => {
        const name = $("#cn").value.trim();
        if (!name) return toast("Give the category a name");

        const btn = $("#cSave");
        btn.disabled = true;
        try {
            await apiPost({
                action: editing ? "update_category" : "create_category",
                category_id: CAT.id,
                name,
                icon: CAT.icon,
                color_hex: CAT.color,
                type: CAT.type === "income" ? "Deposit" : "Withdraw"
            });
            toast(editing ? "Category updated" : "Category added");
            lastSig = "";
            await loadData();
            if ($("#dlg").open) catList();
        } catch (err) {
            btn.disabled = false;
            toast(err.message || "Could not save");
        }
    };
}

// 3) the emoji picker
function emojiPicker(group) {
    showView("Choose an emoji", `
        <div class="chips" style="margin:6px 0">${EMOJI_GROUPS.map((g, i) =>
            `<button type="button" class="chip${i === group ? " on" : ""}" data-eg="${i}" title="${esc(g[1])}" aria-label="${esc(g[1])}">${esc(g[0])}</button>`
        ).join("")}</div>
        <p class="sub" style="margin:0 0 4px">${esc(EMOJI_GROUPS[group][1])}</p>
        <div class="emojis">${EMOJI_GROUPS[group][2].split(" ").map(e =>
            `<button type="button" class="emo" data-e="${esc(e)}">${esc(e)}</button>`
        ).join("")}</div>
        <label for="ecustom">Or type / paste any emoji</label>
        <div class="field-row"><input id="ecustom" maxlength="16" placeholder="😀"><button class="btn o" id="euse">Use</button></div>
        <button class="btn g full" id="eback">Back</button>`);

    const pick = e => { CAT.icon = e; catForm(CAT.id, true); };

    $$("#dB [data-eg]").forEach(b => b.onclick = () => emojiPicker(+b.dataset.eg));
    $$("#dB [data-e]").forEach(b => b.onclick = () => pick(b.dataset.e));
    $("#euse").onclick = () => {
        const e = firstEmoji($("#ecustom").value);
        if (!e) return toast("Type or paste an emoji first");
        pick(e);
    };
    $("#eback").onclick = () => catForm(CAT.id, true);
}


/* =====================================
   FILTERS & MONTH PICKER
===================================== */

function fillMonths() {
    const keys = new Set(DB.transactions.map(t => monthKey(t.date)));
    keys.add(monthKey(new Date()));
    $("#month").innerHTML = [...keys].sort().reverse()
        .map(k => `<option value="${k}">${monthLabel(k)}</option>`).join("");
    $("#month").value = S.month;
}

$("#month").onchange = e => { S.month = e.target.value; render(); };
$("#q").oninput = e => { S.query = e.target.value.toLowerCase(); render(); };
$$("[data-f]").forEach(b => b.onclick = () => {
    S.filter = b.dataset.f;
    $$("[data-f]").forEach(x => x.classList.toggle("on", x === b));
    render();
});


/* =====================================
   WITHDRAWAL APPROVAL
   The ESP32 creates a pending withdrawal in the database.
   - Home shows a banner while one is waiting
   - a pop-up sheet asks Approve / Reject (on any tab)
   - Approve / Reject / Expire are saved to the API,
     and the ESP32 reads the result from there
   - Profile keeps the history
===================================== */

const WD = { id: null, view: "ask", reason: "", seen: new Set(), openTimer: null, filter: "all",
             exp: {}, expiring: new Set(), busy: false };
const RING = 282.7;   // circumference of the countdown ring (r = 45)

const wdWait = () => +DB.settings.withdrawal_approval_seconds || 30;
const wdOpen = () => +DB.settings.servo_open_seconds || 5;
const wdLow = () => +DB.settings.low_balance_alert || 0;
const sameId = (a, b) => String(a) === String(b);
const wdCur = () => DB.withdrawals.find(w => sameId(w.transaction_id, WD.id));
const pendingList = () => DB.withdrawals.filter(w => w.status === "pending");
const secsLeft = w => Math.max(0, Math.ceil((w.expMs - Date.now()) / 1000));
const ringOffset = left => RING * (1 - Math.min(1, left / wdWait()));
const sheetOpen = () => $("#wdlg").open;

// everything in the piggy bank, not just this month
function piggyBalance() {
    const ok = DB.transactions.filter(t => !IGNORED.includes(t.status));
    return total(ok, "income") - total(ok, "expense");
}

function ago(d) {
    const m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return "Just now";
    if (m < 60) return m + " min ago";
    if (m < 1440) return Math.round(m / 60) + " hr ago";
    const days = Math.round(m / 1440);
    return days + (days === 1 ? " day ago" : " days ago");
}

// The time ran out: mark it expired here and tell the server (once).
function expireWithdrawal(w) {
    w.status = "expired";
    const key = String(w.transaction_id);
    if (WD.expiring.has(key)) return;
    WD.expiring.add(key);

    apiPost({ action: "decide_withdrawal", transaction_id: w.transaction_id, decision: "expire" })
        .catch(() => { /* already decided elsewhere, the next refresh will show the truth */ })
        .finally(() => { lastSig = ""; loadData(); });
}


/* ---------- Home banner + Profile history ---------- */

function renderWithdrawals() {
    $("#wdBanner").innerHTML = pendingList().map(w => `
        <div class="card pend-card">
            <div class="ic">🐷</div>
            <div class="m"><strong>${money(w.amount)} withdrawal</strong>
                <small>${esc(w.note || "No note")} · <span data-left="${esc(w.transaction_id)}">${secsLeft(w)}s left</span></small></div>
            <button class="btn o" data-review="${esc(w.transaction_id)}">Review</button>
        </div>`).join("");
    $$("[data-review]").forEach(b => b.onclick = () => openWithdrawal(b.dataset.review));

    const done = DB.withdrawals.filter(w => w.status !== "pending");
    $("#pc").textContent = done.length;

    const rows = done.filter(w => WD.filter === "all" || w.status === WD.filter).sort((a, b) => b.at - a.at);
    const icon = { approved: "✅", rejected: "🚫", expired: "⏱️" };
    $("#wList").innerHTML = rows.length ? rows.map(w => `
        <div class="tx">
            <div class="ic" style="background:var(--line)">${icon[w.status] || "•"}</div>
            <div class="m"><strong>${money(w.amount)} · ${esc(w.note || "No note")}</strong>
                <small>${ago(w.at)}${w.status === "rejected" && w.cancel_reason ? " · " + esc(w.cancel_reason) : ""}</small></div>
            <span class="st ${esc(w.status)}">${esc(w.status[0].toUpperCase() + w.status.slice(1))}</span>
        </div>`).join("")
        : '<div class="empty">No withdrawals to show.</div>';
}

$$("[data-wf]").forEach(b => b.onclick = () => {
    WD.filter = b.dataset.wf;
    $$("[data-wf]").forEach(x => x.classList.toggle("on", x === b));
    renderWithdrawals();
});


/* ---------- The approval sheet ---------- */

function openWithdrawal(id) {
    const w = DB.withdrawals.find(x => sameId(x.transaction_id, id));
    if (!w) return;
    WD.id = w.transaction_id;
    WD.reason = "";
    WD.view = w.status === "pending" ? "ask" : w.status;   // ask | reason | approved | rejected | expired
    drawSheet();
    if (!sheetOpen()) $("#wdlg").showModal();
}

function closeSheet() { $("#wdlg").close(); }

function drawSheet() {
    const w = wdCur();
    if (!w) return;
    const s = $("#wsheet");
    const closeBtn = '<button class="wx" id="wx" aria-label="Close">✕</button>';
    const doneBtn = '<button class="btn full g" id="wdone">Done</button>';

    if (WD.view === "ask") {
        const left = secsLeft(w), balance = piggyBalance(), after = balance - w.amount;
        const time = w.at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: is12h() });
        const warn = after < 0 ? `This is more than the ${money(balance)} recorded in your piggy bank.`
                   : after < wdLow() ? `This would leave less than ${money(wdLow())} in your piggy bank.` : "";
        s.innerHTML = `${closeBtn}<span class="tag">Withdrawal request</span>
            <div class="ring${left <= 10 ? " low" : ""}" id="ring">
                <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="bg" cx="50" cy="50" r="45"/>
                <circle class="fg" id="wfg" cx="50" cy="50" r="45" stroke-dasharray="${RING}" stroke-dashoffset="${ringOffset(left)}"/></svg>
                <div class="mid"><b id="wsecs">${left}</b><span>seconds left</span></div>
            </div>
            <h2 id="wtitle">Someone wants to take out</h2>
            <div class="amount">${money(w.amount)}</div>
            <div class="facts">
                <div><span>For</span><b>${esc(w.note || "No note")}</b></div>
                <div><span>Requested at</span><b>${time}</b></div>
                <div><span>Balance after</span><b>${money(after)}</b></div>
            </div>
            ${warn ? `<div class="alert">⚠️ ${warn}</div>` : ""}
            <div class="btns"><button class="btn ghost full" id="wrej">Reject</button><button class="btn ok full" id="wacc">Approve</button></div>
            <p class="hint">Approving opens the piggy bank for ${wdOpen()} seconds. Not you? Reject it.</p>`;
        $("#wacc").onclick = approveWithdrawal;
        $("#wrej").onclick = () => { WD.view = "reason"; drawSheet(); };

    } else if (WD.view === "reason") {
        s.innerHTML = `${closeBtn}<h2 id="wtitle" style="margin-top:6px">Why are you rejecting ${money(w.amount)}?</h2>
            <p class="sub">This is saved in your activity log.</p>
            <div class="reasons">${REASONS.map((r, i) => `<button data-r="${i}" class="${r === WD.reason ? "on" : ""}">${esc(r)}</button>`).join("")}</div>
            <div class="btns"><button class="btn g full" id="wback">Back</button><button class="btn o full" id="wconf">Reject</button></div>`;
        $$("[data-r]").forEach(b => b.onclick = () => { WD.reason = REASONS[+b.dataset.r]; drawSheet(); });
        $("#wback").onclick = () => { WD.view = "ask"; drawSheet(); };
        $("#wconf").onclick = rejectWithdrawal;

    } else if (WD.view === "approved") {
        s.innerHTML = `${closeBtn}<div class="big-ic pop" style="background:rgba(18,145,95,.15)">🔓</div>
            <h2 id="wtitle">Approved · ${money(w.amount)}</h2>
            <p class="sub" id="openMsg">Piggy bank is open for <b id="oc">${wdOpen()}</b> seconds…</p>${doneBtn}`;

    } else if (WD.view === "rejected") {
        s.innerHTML = `${closeBtn}<div class="big-ic pop" style="background:rgba(244,79,29,.15)">🚫</div>
            <h2 id="wtitle">Rejected</h2>
            <p class="sub">The piggy bank stays locked.${w.cancel_reason ? " Reason: " + esc(w.cancel_reason) + "." : ""}</p>${doneBtn}`;

    } else {
        s.innerHTML = `${closeBtn}<div class="big-ic pop" style="background:var(--line)">⏱️</div>
            <h2 id="wtitle">Request expired</h2>
            <p class="sub">No answer in ${wdWait()} seconds, so it was cancelled automatically. Nothing was taken out.</p>${doneBtn}`;
    }

    $("#wx").onclick = closeSheet;
    const d = $("#wdone");
    if (d) d.onclick = closeSheet;
}

$("#wdlg").onclick = e => { if (e.target.id === "wdlg") closeSheet(); };
$("#wdlg").addEventListener("close", renderWithdrawals);


/* ---------- Approve / reject (saved to the API) ---------- */

// The server said no (already decided, expired, offline...). Show the real state.
async function resyncAfterError(err) {
    toast(err.message || "Something went wrong");
    lastSig = "";
    await loadData();
    const c = wdCur();
    if (c && c.status !== "pending" && sheetOpen()) { WD.view = c.status; drawSheet(); }
}

async function approveWithdrawal() {
    const w = wdCur();
    if (!w || w.status !== "pending" || secsLeft(w) <= 0 || WD.busy) return;
    WD.busy = true;
    try {
        await apiPost({ action: "decide_withdrawal", transaction_id: w.transaction_id, decision: "approve" });
        w.status = "approved";
        const t = DB.transactions.find(x => sameId(x.transaction_id, w.transaction_id));
        if (t) t.status = "approved";          // now counts towards expenses
        WD.view = "approved";
        drawSheet();
        runOpenCountdown();
        render();
        lastSig = "";                          // refresh from the server on the next poll
    } catch (err) {
        await resyncAfterError(err);
    } finally {
        WD.busy = false;
    }
}

async function rejectWithdrawal() {
    const w = wdCur();
    if (!w || w.status !== "pending" || WD.busy) return;
    if (!WD.reason) return toast("Pick a reason first");
    WD.busy = true;
    try {
        await apiPost({ action: "decide_withdrawal", transaction_id: w.transaction_id,
                        decision: "reject", reason: WD.reason });
        w.status = "rejected";
        w.cancel_reason = WD.reason;
        WD.view = "rejected";
        drawSheet();
        render();
        lastSig = "";
    } catch (err) {
        await resyncAfterError(err);
    } finally {
        WD.busy = false;
    }
}

// visual only countdown while the piggy bank is open
function runOpenCountdown() {
    clearInterval(WD.openTimer);
    let n = wdOpen();
    WD.openTimer = setInterval(() => {
        n--;
        const count = $("#oc"), msg = $("#openMsg");
        if (n <= 0) {
            clearInterval(WD.openTimer);
            if (msg) msg.textContent = "🔒 Piggy bank is closed again.";
        } else if (count) {
            count.textContent = n;
        }
    }, 1000);
}


/* ---------- Live countdown ---------- */

setInterval(() => {
    pendingList().forEach(w => {
        const left = secsLeft(w);
        const showing = sameId(WD.id, w.transaction_id);

        if (left <= 0) {
            expireWithdrawal(w);
            renderWithdrawals();
            if (showing && sheetOpen() && (WD.view === "ask" || WD.view === "reason")) {
                WD.view = "expired";
                drawSheet();
            }
            return;
        }

        $$(`[data-left="${w.transaction_id}"]`).forEach(el => el.textContent = left + "s left");
        if (showing && WD.view === "ask" && $("#wfg")) {
            $("#wsecs").textContent = left;
            $("#wfg").style.strokeDashoffset = ringOffset(left);
            $("#ring").classList.toggle("low", left <= 10);
        }
    });
}, 250);


/* ---------- New requests ---------- */

// pops the sheet up the first time a pending request is seen
function checkIncoming() {
    const fresh = pendingList().filter(w => !WD.seen.has(String(w.transaction_id)));
    if (!fresh.length) return;
    fresh.forEach(w => WD.seen.add(String(w.transaction_id)));
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) { /* not supported */ }

    try {
        if (sheetOpen()) toast("Another withdrawal request arrived");
        else openWithdrawal(fresh[0].transaction_id);
    } catch (e) {
        console.error("Pop-up error:", e);
        toast("Can't open the request: " + e.message);
    }
}


/* =====================================
   START
===================================== */

(function init() {
    DB = {
        user: { full_name: "", email: "" },
        settings: { currency_symbol: "₱", timezone: "Asia/Manila", time_format: "12h", monthly_budget: 0,
                    low_balance_alert: 0, withdrawal_approval_seconds: 30, servo_open_seconds: 5 },
        categories: [],
        transactions: [], goals: [], notifications: [], withdrawals: []
    };
    S.month = monthKey(new Date());
    fillMonths();
    render();

    loadData();
    // "Log out" must end the session, not just go back to the login page
    const logoutLink = $(".out-btn");
    if (logoutLink) logoutLink.setAttribute("href", "logout.php");

    setInterval(loadData, POLL_MS);
})();