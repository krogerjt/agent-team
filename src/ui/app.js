const state = { repo: "", head: "", profiles: [], runs: [], library: "", jobs: {}, selectedRun: null, selectedAgent: "marlow", view: "workshop", panelTab: "chat", review: null, events: [], apiToken: "" };
const dismissedPrompts = new Set();
const colors = {
  marlow: ["#8b9ce8", "#d6d8c8", "#24356d", "#e6b899"],
  juniper: ["#a775d6", "#26212e", "#664091", "#a96543"],
  kit: ["#5a9cdb", "#29333d", "#285c9d", "#efc6a5"],
  wren: ["#efa4c8", "#20202e", "#e09bbd", "#f0c2b8"],
  rowan: ["#b460a5", "#6b4430", "#78437c", "#a6704c"],
  tove: ["#b5c9ed", "#f6d06f", "#8faee0", "#f0cba9"],
  piper: ["#78bd91", "#b74731", "#356c57", "#efbd9f"],
};
const moods = { marlow: "Every good build begins with a plan.", juniper: "The answer is probably in the codebase.", kit: "Give me a problem and a test bench.", wren: "The details are the experience.", rowan: "Let's make this hold up under review.", tove: "I'll make sure we remember what matters.", piper: "Let me get the workshop running." };
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const $ = (selector) => document.querySelector(selector);
const el = (tag, className, content) => { const node = document.createElement(tag); node.className = className; node.textContent = content; return node; };
const profile = (id) => state.profiles.find((item) => item.id === id);
const currentRun = () => state.runs.find((item) => item.id === state.selectedRun);
const fmt = (date) => { try { return new Date(date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return date; } };

function avatar(id, size = "") {
  const [accent, hair, coat, skin] = colors[id];
  const headwear = id === "marlow" ? `<rect x="13" y="7" width="28" height="5" fill="${hair}"/><rect x="10" y="12" width="34" height="3" fill="${hair}"/>` :
    id === "kit" ? `<rect x="11" y="9" width="32" height="7" fill="${accent}"/><rect x="10" y="15" width="33" height="3" fill="#d7e6f6"/>` :
    id === "wren" ? `<rect x="11" y="8" width="32" height="8" fill="${accent}"/><rect x="9" y="16" width="35" height="4" fill="${accent}"/>` :
    id === "juniper" ? `<rect x="11" y="7" width="32" height="8" fill="${hair}"/><rect x="12" y="15" width="30" height="4" fill="${accent}"/>` :
    id === "tove" ? `<rect x="11" y="7" width="32" height="10" fill="${hair}"/><rect x="8" y="15" width="9" height="28" fill="${hair}"/><rect x="37" y="15" width="9" height="28" fill="${hair}"/>` :
    id === "piper" ? `<rect x="10" y="7" width="34" height="12" fill="${hair}"/><rect x="8" y="15" width="8" height="23" fill="${hair}"/><rect x="38" y="15" width="8" height="23" fill="${hair}"/><rect x="18" y="9" width="18" height="4" fill="#db7a4b"/>` :
    `<rect x="11" y="8" width="32" height="10" fill="${hair}"/><rect x="11" y="18" width="5" height="17" fill="${hair}"/><rect x="38" y="18" width="5" height="17" fill="${hair}"/>`;
  const beard = id === "marlow" || id === "rowan" ? `<rect x="18" y="32" width="19" height="7" fill="${hair}"/><rect x="22" y="37" width="11" height="3" fill="${hair}"/>` : "";
  const glasses = id === "marlow" ? `<rect x="15" y="25" width="11" height="7" fill="none" stroke="#38364e" stroke-width="2"/><rect x="29" y="25" width="11" height="7" fill="none" stroke="#38364e" stroke-width="2"/><rect x="26" y="27" width="3" height="2" fill="#38364e"/>` : "";
  return `<svg class="avatar ${size}" viewBox="0 0 54 82" role="img" aria-label="${id} pixel character" shape-rendering="crispEdges"><rect x="8" y="46" width="9" height="25" fill="${coat}"/><rect x="38" y="46" width="9" height="25" fill="${coat}"/><rect x="10" y="66" width="7" height="7" fill="${skin}"/><rect x="38" y="66" width="7" height="7" fill="${skin}"/><rect x="17" y="43" width="21" height="29" fill="${coat}"/><rect x="16" y="43" width="22" height="5" fill="${accent}"/><rect x="19" y="72" width="7" height="9" fill="#3e3545"/><rect x="30" y="72" width="7" height="9" fill="#3e3545"/><rect x="14" y="16" width="28" height="25" fill="${skin}"/><rect x="12" y="22" width="4" height="14" fill="${skin}"/><rect x="40" y="22" width="4" height="14" fill="${skin}"/>${headwear}<rect x="20" y="27" width="3" height="3" fill="#252b3c"/><rect x="32" y="27" width="3" height="3" fill="#252b3c"/>${beard}${glasses}<rect x="25" y="34" width="5" height="2" fill="#b87973"/><rect x="26" y="48" width="3" height="13" fill="#d8d3c8"/></svg>`;
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(state.apiToken ? { "X-Agent-Team-Token": state.apiToken } : {}), ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function notify(message, error = false) {
  const notice = $("#notice"); notice.textContent = message; notice.className = `notice visible ${error ? "error" : ""}`;
  clearTimeout(notify.timer); notify.timer = setTimeout(() => notice.classList.remove("visible"), 6500);
}

async function refresh(quiet = false) {
  try {
    const data = await api("/api/bootstrap");
    const previousRuns = state.runs;
    const previousSignature = JSON.stringify(previousRuns.map((run) => ({ id: run.id, status: run.status, plan: run.plan, tasks: run.tasks })));
    const goalDraft = $("#goal-input")?.value;
    const answerDraft = $("#answer-form input")?.value;
    Object.assign(state, data);
    if (!state.selectedRun || !state.runs.some((item) => item.id === state.selectedRun)) state.selectedRun = state.runs[0]?.id || null;
    renderSidebar();
    if (!quiet || previousSignature !== JSON.stringify(state.runs.map((run) => ({ id: run.id, status: run.status, plan: run.plan, tasks: run.tasks })))) {
      renderMain();
      if (goalDraft !== undefined && $("#goal-input")) $("#goal-input").value = goalDraft;
      if (answerDraft !== undefined && $("#answer-form input")) $("#answer-form input").value = answerDraft;
    } else if (currentRun()) void loadEvents(currentRun().id);
    if (!quiet) renderPanel();
    if (state.view === "bench") void loadBench();
    const before = previousRuns.find((item) => item.id === state.selectedRun);
    const after = currentRun();
    if (quiet && before && after && before.status !== after.status) {
      if (after.status === "blocked") notify("Someone at the workshop needs your answer.");
      if (after.status === "awaiting-review") notify("The team finished. Your review is ready.");
    }
    $("#repo-name").textContent = data.repo.split(/[\\/]/).pop();
  } catch (error) { if (!quiet) notify(error.message, true); }
}

function renderSidebar() {
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  $("#page-title").textContent = state.view === "library" ? "SHARED LIBRARY" : state.view === "bench" ? "TEST BENCH" : "WORKSHOP";
  $("#run-list").innerHTML = state.runs.length ? state.runs.slice(0, 8).map((run) => `<button class="run-nav ${run.id === state.selectedRun && state.view === "workshop" ? "selected" : ""}" data-run="${escapeHtml(run.id)}"><span class="run-dot ${escapeHtml(run.status)}"></span><span><strong>${escapeHtml(run.goal)}</strong><small>${escapeHtml(run.status.replaceAll("-", " "))} · ${fmt(Number(run.id.split("-")[0]))}</small></span></button>`).join("") : `<p class="sidebar-empty">Your first goal will appear here.</p>`;
}

function taskLabel(task, run) { return run?.plan?.tasks.find((item) => item.id === task.id)?.title || task.id; }
function agentStatus(id, run) {
  if (!run) return "At their desk";
  const task = run.tasks.find((item) => run.plan?.tasks.find((plan) => plan.id === item.id)?.worker === id && ["doing", "review", "blocked"].includes(item.status));
  if (task) return task.status === "blocked" ? "Needs your input" : task.status === "review" ? "In review" : "Working on a task";
  if (run.status === "planning" && id === "marlow") return "Planning the goal";
  if (run.status === "doing" && id === "juniper") return "Researching";
  if (run.status === "awaiting-review" && id === "tove") return "QA complete";
  if (id === "piper" && run.preview?.status === "healthy") return "Preview running";
  if (id === "piper" && ["waiting-secret", "waiting-approval", "failed"].includes(run.preview?.status)) return "Needs your input";
  return "At their desk";
}

function renderMain() {
  const main = $("#main-content");
  if (state.view === "library") {
    $("#input-prompt")?.remove();
    main.innerHTML = `<section class="library-page"><div class="eyebrow">THE SHARED SHELF</div><h1>What the team knows, together.</h1><p>Decisions and verified repository notes are added after you review and merge a finished goal. Each agent also keeps a personal journal at their desk.</p><div class="library-paper"><div class="paper-header"><span>▤</span> REPOSITORY LIBRARY</div><pre>${escapeHtml(state.library || "The shelves are quiet for now. Complete and merge a goal to start the shared library.")}</pre></div></section>`;
    return;
  }
  if (state.view === "bench") { renderBench(); return; }
  const run = currentRun();
  const blocked = run?.tasks.find((task) => task.status === "blocked");
  const piperNeeds = run?.status === "blocked" && run.preview?.issue && !blocked;
  if ((!blocked && !piperNeeds) || $("#input-prompt")?.dataset.run !== run.id) $("#input-prompt")?.remove();
  const worker = blocked && run?.plan?.tasks.find((task) => task.id === blocked.id)?.worker;
  main.innerHTML = `
    <section class="hero"><div class="hero-copy"><div class="eyebrow"><span class="spark">✦</span> A SMALL FACTORY FOR BIG IDEAS</div><h1>Good things are<br><em>built together.</em></h1><p>Give your team a goal, watch each desk light up, and step in when they need you.</p></div><div class="hero-cube" aria-hidden="true"><div class="cube-top"></div><div class="cube-left"></div><div class="cube-right"></div><span>✦</span></div></section>
    <form id="goal-form" class="goal-composer"><div class="composer-icon">✎</div><label for="goal-input"><strong>What should the team build?</strong><span>Describe a coding goal for this repository.</span></label><input id="goal-input" name="goal" maxlength="4000" placeholder="e.g. Add a friendly empty state to the dashboard" required><button class="primary-button" type="submit">Start goal <span>↗</span></button></form>
    ${blocked ? `<section class="summons" role="alert"><div class="summons-portrait">${avatar(worker || "marlow", "small")}</div><div class="summons-copy"><span class="eyebrow">A QUESTION FROM ${escapeHtml(worker || "THE TEAM")}</span><h2>${escapeHtml(profile(worker)?.name || "The team")} needs your help.</h2><p>${escapeHtml(blocked.error || "This task needs a decision before work can continue.")}</p><form id="answer-form"><input name="answer" maxlength="8000" aria-label="Your answer" placeholder="Type your answer or direction…" required><button class="primary-button">Send answer →</button></form></div></section>` : piperNeeds ? `<section class="summons" role="alert"><div class="summons-portrait">${avatar("piper", "small")}</div><div class="summons-copy"><span class="eyebrow">PIPER AT THE TEST BENCH</span><h2>Piper needs your help.</h2><p>${escapeHtml(run.preview.issue)}</p><button class="primary-button" data-view="bench">Open Test Bench →</button></div></section>` : ""}
    ${run?.status === "awaiting-review" ? `<section class="review-banner"><div><span class="eyebrow">${run.baseCommit === state.head ? "READY FOR YOU" : "PAST RUN"}</span><h2>${run.baseCommit === state.head ? "The team has finished building." : "This build is still here to review."}</h2><p>${run.baseCommit === state.head ? "Review the changes and checks before merging into your main checkout." : "Your main checkout has moved on since this run. Start a new goal to build from the latest code."}</p></div><button class="secondary-button" id="review-button">Open review ↗</button></section>` : ""}
    <section class="section-heading"><div><div class="eyebrow">MEET THE TEAM</div><h2>The workshop floor <span class="head-spark">✦</span></h2></div><p>Click a desk to chat, set its model, or open its journal.</p></section>
    <div class="factory-floor">${state.profiles.map((item, index) => `<button class="station station-${item.id} ${state.selectedAgent === item.id ? "picked" : ""}" data-agent="${item.id}" style="--accent:${colors[item.id][0]};--order:${index}"><span class="station-top"><span class="station-number">0${index + 1} / 0${state.profiles.length}</span><span class="station-light ${agentStatus(item.id, run) === "Needs your input" ? "urgent" : ""}"></span></span><span class="station-scene"><span class="scene-glow"></span><span class="monitor"><span class="monitor-lines"><i></i><i></i><i></i></span></span>${avatar(item.id)}<span class="desk"><span class="desk-top"></span><span class="desk-front"></span></span></span><span class="station-info"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.specialty)}</small></span><span class="station-foot"><span class="tiny-dot"></span>${escapeHtml(agentStatus(item.id, run))}<span class="station-open">↗</span></span></button>`).join("")}</div>
    <section class="lower-grid"><div class="wall-card"><div class="card-title"><span>▤</span><div><small>CURRENT GOAL</small><h3>Task wall</h3></div></div>${run ? `<p class="wall-goal">${escapeHtml(run.goal)}</p><div class="status-chip ${escapeHtml(run.status)}">${escapeHtml(run.status.replaceAll("-", " "))}</div>${run.plan ? `<div class="task-stack">${run.tasks.map((task) => { const plan = run.plan.tasks.find((item) => item.id === task.id); return `<div class="task-row"><span class="task-check ${escapeHtml(task.status)}">${task.status === "done" ? "✓" : task.status === "blocked" ? "!" : "•"}</span><div><strong>${escapeHtml(taskLabel(task, run))}</strong><small>${escapeHtml(profile(plan?.worker)?.name || "Team")} · ${escapeHtml(task.status)}</small></div></div>`; }).join("")}</div>` : `<p class="subtle">Marlow is drawing up a plan…</p>`}` : `<div class="wall-empty"><span>◇</span><p>No goal on the wall yet.<br>Start one above to set the workshop in motion.</p></div>`}</div><div class="activity-card"><div class="card-title"><span>✧</span><div><small>THE WORKSHOP</small><h3>Live notes</h3></div></div><div id="activity-list"><p class="subtle">${run ? "Loading recent activity…" : "The desks are ready. Your team's story starts with a goal."}</p></div></div></section>`;
  if (run) void loadEvents(run.id);
  if (blocked && !dismissedPrompts.has(run.id)) showInputPrompt(run, blocked, worker);
  if (piperNeeds && !dismissedPrompts.has(run.id)) showPiperPrompt(run);
}

function showInputPrompt(run, blocked, worker) {
  if ($("#input-prompt")) return;
  const name = profile(worker)?.name || "The team";
  const modal = document.createElement("div");
  modal.className = "input-prompt-backdrop";
  modal.id = "input-prompt";
  modal.dataset.run = run.id;
  modal.innerHTML = `<div class="input-prompt" role="dialog" aria-modal="true" aria-label="${escapeHtml(name)} needs your input"><button class="prompt-close" data-close="input" aria-label="Answer later">✕</button><div class="prompt-scene"><div class="prompt-podium"></div>${avatar(worker || "marlow", "prompt-avatar")}<span class="prompt-alert">!</span></div><span class="eyebrow">A MESSAGE FROM THE WORKSHOP</span><h2>${escapeHtml(name)} needs your direction.</h2><p>${escapeHtml(blocked.error || "What should I do next?")}</p><form id="answer-pop-form"><textarea name="answer" rows="3" maxlength="8000" placeholder="Write your answer…" required></textarea><button class="primary-button" type="submit">Send answer to ${escapeHtml(name)} →</button></form><small>You can answer later from the task wall.</small></div>`;
  document.body.append(modal);
}

function showPiperPrompt(run) {
  if ($("#input-prompt")) return;
  const modal = document.createElement("div");
  modal.className = "input-prompt-backdrop"; modal.id = "input-prompt"; modal.dataset.run = run.id;
  modal.innerHTML = `<div class="input-prompt" role="dialog" aria-modal="true" aria-label="Piper needs input"><button class="prompt-close" data-close="input" aria-label="Answer later">✕</button><div class="prompt-scene"><div class="prompt-podium"></div>${avatar("piper", "prompt-avatar")}<span class="prompt-alert">!</span></div><span class="eyebrow">FROM THE TEST BENCH</span><h2>Piper needs your help.</h2><p>${escapeHtml(run.preview.issue)}</p><button class="primary-button" data-view="bench">Open Test Bench →</button></div>`;
  document.body.append(modal);
}

function renderBench() {
  $("#input-prompt")?.remove();
  const run = currentRun();
  $("#main-content").innerHTML = `<section class="bench-page"><div class="eyebrow">PIPER'S CORNER OF THE WORKSHOP</div><h1>The Test Bench</h1><p>See the staged app running locally, check the browser results, and inspect Wren's finished-interface review.</p>${run ? `<div class="bench-toolbar"><strong>${escapeHtml(run.goal)}</strong><button class="secondary-button" id="bench-start">Start preview</button><button class="secondary-button" id="bench-stop">Stop preview</button></div><div id="bench-details"><p class="subtle">Checking the bench…</p></div><div class="bench-screen" id="bench-screen"></div><div class="bench-columns"><div class="bench-card"><h3>Latest capture</h3><div id="bench-shot"></div></div><div class="bench-card"><h3>Browser steps & Wren's notes</h3><div id="bench-results"></div></div></div><div class="bench-card"><h3>Piper's command log</h3><pre id="bench-log">Loading…</pre></div>` : `<div class="wall-empty"><span>◇</span><p>Start a goal to use the Test Bench.</p></div>`}<div class="bench-card"><h3>Shared secret shelf</h3><p>Values are stored locally for this Windows account. Piper can see names, never values.</p><div id="secret-names"></div><form id="secret-form" class="bench-secret-form"><input name="name" placeholder="Secret name" required><input name="value" type="password" placeholder="Secret value" required><button class="secondary-button">Save secret</button></form></div></section>`;
  void loadBench();
}

async function loadBench() {
  if (state.view !== "bench") return;
  const run = currentRun();
  try {
    const secrets = await api("/api/secrets");
    if ($("#secret-names")) $("#secret-names").textContent = secrets.names.length ? secrets.names.join(" · ") : "No secrets saved yet.";
    if (!run) return;
    const info = await api(`/api/runs/${run.id}/preview`);
    if (state.selectedRun !== run.id || state.view !== "bench") return;
    const status = info.status || "not configured";
    const details = $("#bench-details");
    const secretDraft = $("#requested-secret-form input")?.value;
    details.innerHTML = `<div class="bench-status"><span class="tiny-dot"></span><strong>${escapeHtml(status.replaceAll("-", " "))}</strong>${info.live ? `<span>Live at ${escapeHtml(info.url)}</span>` : ""}</div>${info.issue ? `<p class="bench-issue">${escapeHtml(info.issue)}</p>` : ""}${info.status === "waiting-approval" ? `<div class="bench-decision"><p>Piper flagged this command:</p><code>${escapeHtml(info.command)}</code><div><button class="primary-button" id="bench-approve">Run this command</button><button class="secondary-button" id="bench-reject">Do not run</button></div></div>` : ""}${info.status === "waiting-secret" ? `<form id="requested-secret-form" class="bench-secret-form"><p>Piper needs <strong>${escapeHtml(info.secret)}</strong>. Enter a value for the shared secret shelf.</p><input name="value" type="password" placeholder="Value for ${escapeHtml(info.secret)}" required><button class="primary-button">Save and continue</button></form>` : ""}${info.visualVerified === false ? `<p class="subtle">Wren reviewed page structure and browser steps. Visual model review was unavailable.</p>` : ""}${info.cookbook ? `<details class="bench-cookbook"><summary>Piper's environment cookbook</summary><pre>${escapeHtml(JSON.stringify(info.cookbook, null, 2))}</pre></details>` : ""}`;
    if (secretDraft !== undefined && $("#requested-secret-form input")) $("#requested-secret-form input").value = secretDraft;
    const screen = $("#bench-screen");
    if (info.live && info.url) {
      if (screen.dataset.url !== info.url) { screen.dataset.url = info.url; screen.innerHTML = `<div class="bench-screen-head"><span>LIVE PREVIEW</span><a href="${escapeHtml(info.url)}" target="_blank" rel="noopener">Open in a tab ↗</a></div><iframe src="${escapeHtml(info.url)}" sandbox="allow-scripts allow-forms allow-same-origin" title="Staged app preview"></iframe>`; }
    } else { screen.dataset.url = ""; screen.innerHTML = `<div class="bench-offline">The preview is resting. Start it to open the staged app.</div>`; }
    const shot = $("#bench-shot");
    const shotUrl = info.screenshot ? `/api/runs/${run.id}/preview/screenshot?t=${encodeURIComponent(info.captureAt || "latest")}` : "";
    if (shot.dataset.url !== shotUrl) { shot.dataset.url = shotUrl; shot.innerHTML = shotUrl ? `<img src="${shotUrl}" alt="Latest staged interface capture">` : `<p class="subtle">No screenshot yet.</p>`; }
    $("#bench-results").innerHTML = `${(info.browserResults || []).map((result) => `<div class="bench-result ${escapeHtml(result.status)}"><strong>${escapeHtml(result.status)} · ${escapeHtml(result.step)}</strong><p>${escapeHtml(result.detail)}</p></div>`).join("") || `<p class="subtle">No browser steps yet.</p>`}${info.visualReview ? `<div class="bench-review"><strong>Wren's review</strong><p>${escapeHtml(info.visualReview)}</p></div>` : ""}`;
    $("#bench-log").textContent = info.log || "No command output yet.";
  } catch (error) { if ($("#bench-details")) $("#bench-details").textContent = error.message; }
}

async function loadEvents(id) {
  try {
    const events = await api(`/api/runs/${id}/events`);
    if (state.selectedRun !== id || state.view !== "workshop") return;
    const node = $("#activity-list"); if (!node) return;
    node.innerHTML = events.length ? events.slice(-5).reverse().map((event) => `<div class="activity-item"><span class="activity-dot"></span><div><strong>${escapeHtml(profile(event.persona)?.name || event.persona)} <span>${escapeHtml(event.event.replaceAll("-", " "))}</span></strong><p>${escapeHtml(event.detail)}</p><small>${fmt(event.at)}</small></div></div>`).join("") : `<p class="subtle">The team is getting settled…</p>`;
  } catch { /* transient state write */ }
}

function renderPanel() {
  const item = profile(state.selectedAgent) || state.profiles[0]; if (!item) return;
  const effective = item.effective || { provider: "mock" };
  const chat = item.chat || [];
  $("#detail-panel").innerHTML = `<div class="panel-head" style="--accent:${colors[item.id][0]}"><div class="panel-top"><span>PERSONAL DESK / 0${state.profiles.indexOf(item) + 1}</span><span class="panel-star">✦</span></div><div class="panel-person">${avatar(item.id, "panel-avatar")}<div><small>${escapeHtml(item.specialty)}</small><h2>${escapeHtml(item.name)}</h2><p>“${escapeHtml(moods[item.id])}”</p></div></div><div class="panel-tabs"><button class="${state.panelTab === "chat" ? "active" : ""}" data-tab="chat">Chat</button><button class="${state.panelTab === "journal" ? "active" : ""}" data-tab="journal">Journal</button><button class="${state.panelTab === "settings" ? "active" : ""}" data-tab="settings">Model</button></div></div>
    <div class="panel-body">${state.panelTab === "chat" ? `<div class="chat-window" id="chat-window">${chat.length ? chat.map((entry) => `<div class="chat-bubble ${entry.role}"><span>${entry.role === "user" ? "YOU" : escapeHtml(item.name.toUpperCase())}</span><p>${escapeHtml(entry.text)}</p><small>${fmt(entry.at)}</small></div>`).join("") : `<div class="chat-empty"><span>✳</span><h3>Pull up a chair.</h3><p>Ask ${escapeHtml(item.name)} about the repository, a goal, or what they've been working on.</p></div>`}</div><form id="chat-form" class="chat-form"><textarea name="message" rows="2" maxlength="8000" placeholder="Message ${escapeHtml(item.name)}…" required></textarea><button class="send-button" aria-label="Send message">↗</button></form><p class="panel-hint">Conversations are saved to ${escapeHtml(item.name)}'s personal desk.</p>` : ""}
    ${state.panelTab === "journal" ? `<div class="journal-intro"><span>▤</span><h3>${escapeHtml(item.name)}'s journal</h3><p>A personal space for character, reminders, and the work they've done.</p></div><form id="journal-form"><label>PERSONALITY & TRAITS<textarea name="traits" rows="4" maxlength="4000" placeholder="How does this agent approach work?">${escapeHtml(item.traits)}</textarea></label><label>PINNED MEMORY<textarea name="memory" rows="6" maxlength="12000" placeholder="Facts or preferences this agent should carry into future work…">${escapeHtml(item.memory)}</textarea></label><button class="secondary-button" type="submit">Save journal</button></form><div class="journal-history"><h4>SEARCHABLE TIMELINE</h4><form id="timeline-form" class="timeline-form"><input name="query" maxlength="200" placeholder="Search work, features, or decisions…" aria-label="Search timeline"><div class="timeline-dates"><label>FROM<input name="from" type="date"></label><label>TO<input name="to" type="date"></label></div><details><summary>More filters</summary><input name="feature" maxlength="200" placeholder="Feature or task" aria-label="Feature filter"><input name="file" maxlength="300" placeholder="File path" aria-label="File filter"></details><button class="secondary-button" type="submit">Search journal</button></form><div id="timeline-list"><p class="subtle">Loading the timeline…</p></div></div>` : ""}
    ${state.panelTab === "settings" ? `<div class="settings-intro"><span>◈</span><h3>Choose ${escapeHtml(item.name)}'s model</h3><p>Each desk can use its own provider and model. Your API keys stay in the local .env file.</p></div><form id="model-form"><label>PROVIDER<select name="provider" id="provider-select"><option value="mock" ${effective.provider === "mock" ? "selected" : ""}>Mock · demo mode</option><option value="openai" ${effective.provider === "openai" ? "selected" : ""}>OpenAI</option><option value="anthropic" ${effective.provider === "anthropic" ? "selected" : ""}>Anthropic</option><option value="bedrock" ${effective.provider === "bedrock" ? "selected" : ""}>Amazon Bedrock</option></select></label><label>MODEL NAME<input name="model" id="model-input" list="known-models" value="${escapeHtml(effective.model || "")}" placeholder="Choose or enter a model ID" spellcheck="false"><datalist id="known-models">${[...new Set(state.profiles.filter((person) => person.effective?.provider === effective.provider).map((person) => person.effective.model).filter(Boolean))].map((model) => `<option value="${escapeHtml(model)}"></option>`).join("")}</datalist></label><p class="model-note">Choose a model already used by the team, or enter another ID supported by your account. Saved choices apply to the next goal or chat.</p><button class="secondary-button" type="submit">Save model choice</button></form><div class="setting-foot"><span class="tiny-dot"></span> Current: ${escapeHtml(effective.provider)}${effective.model ? ` / ${escapeHtml(effective.model)}` : ""}</div>` : ""}</div>`;
  const chatWindow = $("#chat-window"); if (chatWindow) chatWindow.scrollTop = chatWindow.scrollHeight;
  if (state.panelTab === "journal") void loadTimeline();
}

async function loadTimeline(form) {
  const id = state.selectedAgent;
  const params = new URLSearchParams();
  if (form) for (const [key, value] of new FormData(form)) {
    const text = value.toString().trim();
    if (!text) continue;
    if ((key === "from" || key === "to") && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const [year, month, day] = text.split("-").map(Number);
      const boundary = new Date(year, month - 1, day + (key === "to" ? 1 : 0));
      params.set(key, new Date(boundary.getTime() - (key === "to" ? 1 : 0)).toISOString());
    } else params.set(key, text);
  }
  params.set("limit", "25");
  try {
    const result = await api(`/api/personas/${id}/timeline?${params}`);
    if (state.selectedAgent !== id || state.panelTab !== "journal") return;
    const node = $("#timeline-list"); if (!node) return;
    node.innerHTML = result.entries.length ? `<p class="timeline-count">${result.total} matching event${result.total === 1 ? "" : "s"}${result.total > result.entries.length ? ` · showing ${result.entries.length}` : ""}</p>${result.entries.map((entry) => `<article class="timeline-entry"><div class="timeline-mark">✦</div><div><time>${fmt(entry.at)}</time><strong>${escapeHtml(entry.summary)}</strong>${entry.feature ? `<small>${escapeHtml(entry.feature)}</small>` : ""}${entry.files?.length ? `<small>Files: ${escapeHtml(entry.files.join(", "))}</small>` : ""}<details><summary>Details</summary><p>${escapeHtml(entry.detail)}</p>${entry.runId ? `<small>Run ${escapeHtml(entry.runId)}${entry.taskId ? ` · ${escapeHtml(entry.taskId)}` : ""}</small>` : ""}</details></div></article>`).join("")}` : `<p class="subtle">No matching events. Try another date, feature, or search term.</p>`;
  } catch (error) { if (state.selectedAgent === id && $("#timeline-list")) $("#timeline-list").textContent = error.message; }
}

async function submitGoal(form) {
  const goal = new FormData(form).get("goal")?.toString().trim(); if (!goal) return;
  const button = form.querySelector("button"); button.disabled = true; button.textContent = "Gathering the team…";
  try { const result = await api("/api/goals", { method: "POST", body: JSON.stringify({ goal }) }); notify("Marlow is gathering the team. The new goal will appear in a moment."); form.reset(); watchJob(result.jobId); }
  catch (error) { notify(error.message, true); }
  finally { button.disabled = false; button.innerHTML = "Start goal <span>↗</span>"; }
}

async function watchJob(id) {
  const timer = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${id}`);
      await refresh(true);
      if (job.runId && state.selectedRun !== job.runId) { const previous = state.selectedRun; state.selectedRun = job.runId; if (previous) void api(`/api/runs/${previous}/preview/stop`, { method: "POST", body: "{}" }); renderSidebar(); renderMain(); }
      if (job.status !== "running") {
        clearInterval(timer); await refresh();
        if (job.status === "error") notify(job.error || "The run stopped.", true);
        else notify("The team has finished this step. Take a look at the task wall.");
      }
    } catch { clearInterval(timer); }
  }, 2500);
}

async function openReview() {
  const run = currentRun(); if (!run) return;
  try {
    state.review = await api(`/api/runs/${run.id}/review`);
    const modal = document.createElement("div"); modal.className = "modal-backdrop"; modal.id = "review-modal";
    modal.innerHTML = `<div class="review-modal" role="dialog" aria-modal="true" aria-label="Review team changes"><div class="review-header"><div><span class="eyebrow">BEFORE IT JOINS YOUR MAIN BRANCH</span><h2>Review the build</h2><p>${escapeHtml(run.goal)}</p></div><button class="icon-button" data-close="review" aria-label="Close review">✕</button></div><div class="review-scroll"><div class="review-summary"><h3>Marlow's note</h3><p>${escapeHtml(run.summary || "No summary yet.")}</p></div>${run.tasks.map((task) => `<div class="review-task"><strong>${escapeHtml(taskLabel(task, run))}</strong><span class="status-chip ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span><p><b>Review:</b> ${escapeHtml(task.review || "Pending")}</p><p><b>QA:</b> ${escapeHtml(task.qa || "Pending")}</p><div class="check-list">${(task.checks || []).map((check) => `<span class="check ${escapeHtml(check.status)}">${escapeHtml(check.name)} · ${escapeHtml(check.status)}</span>`).join("")}</div></div>`).join("")}<h3>Code changes</h3><pre class="diff">${escapeHtml(state.review.diff || "No staged diff to show.")}</pre>${run.memoryNote ? `<div class="review-summary"><h3>Tove's pending library note</h3><p>${escapeHtml(run.memoryNote)}</p></div>` : ""}</div><div class="review-actions"><span>${run.baseCommit === state.head ? "Merge is local. Nothing is pushed." : "This run began from an older checkout and cannot merge here."}</span><button class="primary-button" id="merge-button" ${run.status !== "awaiting-review" || run.baseCommit !== state.head ? "disabled" : ""}>Merge reviewed work →</button></div></div>`;
    document.body.append(modal);
  } catch (error) { notify(error.message, true); }
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button"); if (!target) return;
  if (target.dataset.view) { state.view = target.dataset.view; renderSidebar(); renderMain(); return; }
  if (target.dataset.run) { const previous = state.selectedRun; state.selectedRun = target.dataset.run; if (previous && previous !== state.selectedRun) void api(`/api/runs/${previous}/preview/stop`, { method: "POST", body: "{}" }); state.view = "workshop"; renderSidebar(); renderMain(); return; }
  if (target.dataset.agent) { state.selectedAgent = target.dataset.agent; state.panelTab = "chat"; renderMain(); renderPanel(); if (window.innerWidth <= 1050) $("#detail-panel").scrollIntoView({ behavior: "smooth" }); return; }
  if (target.dataset.tab) { state.panelTab = target.dataset.tab; renderPanel(); return; }
  if (target.dataset.close === "review") { $("#review-modal")?.remove(); return; }
  if (target.dataset.close === "input") { dismissedPrompts.add(state.selectedRun); $("#input-prompt")?.remove(); return; }
  if (target.id === "refresh-button") { await refresh(); notify("Workshop refreshed."); }
  if (target.id === "review-button") await openReview();
  if (target.id === "bench-start" || target.id === "bench-stop") {
    const run = currentRun(); if (!run) return;
    try { const result = await api(`/api/runs/${run.id}/preview/${target.id === "bench-start" ? "start" : "stop"}`, { method: "POST", body: "{}" }); if (result.jobId) watchJob(result.jobId); else await loadBench(); }
    catch (error) { notify(error.message, true); } return;
  }
  if (target.id === "bench-approve" || target.id === "bench-reject") {
    try { const result = await api(`/api/runs/${state.selectedRun}/preview/resolve`, { method: "POST", body: JSON.stringify({ action: target.id === "bench-approve" ? "approve" : "reject" }) }); if (result.jobId) watchJob(result.jobId); await loadBench(); }
    catch (error) { notify(error.message, true); } return;
  }
  if (target.id === "merge-button") {
    target.disabled = true; target.textContent = "Merging…";
    try { await api(`/api/runs/${state.selectedRun}/merge`, { method: "POST", body: "{}" }); $("#review-modal")?.remove(); await refresh(); notify("Reviewed work merged into your local checkout."); }
    catch (error) { target.disabled = false; target.textContent = "Merge reviewed work →"; notify(error.message, true); }
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!["goal-form", "answer-form", "answer-pop-form", "chat-form", "journal-form", "timeline-form", "model-form", "secret-form", "requested-secret-form"].includes(form.id)) return;
  event.preventDefault();
  if (form.id === "goal-form") return submitGoal(form);
  if (form.id === "timeline-form") return loadTimeline(form);
  const button = form.querySelector("button[type=submit], button:not([type])"); if (button) button.disabled = true;
  try {
    if (form.id === "secret-form") { await api("/api/secrets", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); await loadBench(); notify("Secret saved to the shared shelf."); return; }
    if (form.id === "requested-secret-form") { const run = currentRun(); const info = await api(`/api/runs/${run.id}/preview`); const result = await api(`/api/runs/${run.id}/preview/resolve`, { method: "POST", body: JSON.stringify({ action: "secret", name: info.secret, value: new FormData(form).get("value") }) }); form.reset(); watchJob(result.jobId); await loadBench(); return; }
    if (form.id === "answer-form" || form.id === "answer-pop-form") {
      const answer = new FormData(form).get("answer"); const run = currentRun();
      const result = await api(`/api/runs/${run.id}/answer`, { method: "POST", body: JSON.stringify({ answer }) });
      $("#input-prompt")?.remove(); dismissedPrompts.add(run.id);
      notify("Your answer reached the desk. Work is resuming."); watchJob(result.jobId);
    }
    if (form.id === "chat-form") {
      const message = new FormData(form).get("message"); const id = state.selectedAgent;
      const chatWindow = $("#chat-window"); chatWindow?.append(el("div", "chat-bubble user pending", `YOU · ${message}`)); if (chatWindow) chatWindow.scrollTop = chatWindow.scrollHeight;
      const result = await api(`/api/personas/${id}/chat`, { method: "POST", body: JSON.stringify({ message, runId: state.selectedRun }) });
      const item = profile(id); if (item) item.chat = result.profile.chat;
      form.reset(); renderPanel();
    }
    if (form.id === "journal-form") {
      const data = Object.fromEntries(new FormData(form)); const id = state.selectedAgent;
      const item = await api(`/api/personas/${id}`, { method: "PATCH", body: JSON.stringify(data) });
      Object.assign(profile(id), item); renderPanel(); notify(`${profile(id).name}'s journal was saved.`);
    }
    if (form.id === "model-form") {
      const data = Object.fromEntries(new FormData(form)); const id = state.selectedAgent;
      const item = await api(`/api/personas/${id}`, { method: "PATCH", body: JSON.stringify(data) });
      Object.assign(profile(id), item); renderPanel(); notify(`${profile(id).name}'s model choice was saved.`);
    }
  } catch (error) { notify(error.message, true); }
  finally { if (button?.isConnected) button.disabled = false; }
});

document.addEventListener("change", (event) => {
  if (event.target.id !== "provider-select") return;
  const selected = event.target.value;
  const model = $("#model-input");
  model.value = "";
  $("#known-models").innerHTML = [...new Set(state.profiles.filter((person) => person.effective?.provider === selected).map((person) => person.effective.model).filter(Boolean))].map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
  model.placeholder = selected === "mock" ? "No model needed" : "Choose or enter a model ID";
});

await refresh();
setInterval(() => { if (state.view === "workshop") void refresh(true); }, 4000);
