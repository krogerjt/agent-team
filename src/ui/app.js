const state = { repo: "", repositories: [], head: "", profiles: [], runs: [], library: "", jobs: {}, selectedRun: null, selectedAgent: "marlow", view: "workshop", panelTab: "chat", review: null, events: [], apiToken: "", appleProject: false, remoteHost: { enabled: false, target: "" }, statusFilters: { persona: "all", event: "all", run: "selected" }, eventStream: null };
const dismissedPrompts = new Set();
let optionSecrets = {};
let workspaceVersion = 0;
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
const eventColor = (persona) => colors[persona]?.[0] || "#9da7c4";
const eventName = (persona) => profile(persona)?.name || (persona === "host" ? "Workshop" : persona === "user" ? "You" : persona);

function avatar(id, size = "") {
  const [accent, hair, coat, skin] = colors[id];
  const hairBack = id === "tove" ? `<rect x="10" y="13" width="34" height="30" fill="${hair}"/><rect x="7" y="20" width="7" height="27" fill="${hair}"/><rect x="40" y="20" width="7" height="27" fill="${hair}"/>` :
    id === "wren" ? `<rect x="10" y="12" width="34" height="30" fill="${hair}"/><rect x="8" y="20" width="7" height="22" fill="${hair}"/><rect x="39" y="20" width="7" height="22" fill="${hair}"/>` :
    `<rect x="11" y="12" width="32" height="29" fill="${hair}"/><rect x="9" y="20" width="6" height="19" fill="${hair}"/><rect x="39" y="20" width="6" height="19" fill="${hair}"/>`;
  const hairFront = id === "marlow" ? `<rect x="13" y="9" width="28" height="6" fill="${hair}"/><rect x="10" y="13" width="8" height="5" fill="${hair}"/><rect x="36" y="13" width="8" height="5" fill="${hair}"/>` :
    id === "juniper" ? `<rect x="11" y="8" width="32" height="7" fill="${hair}"/><rect x="9" y="13" width="8" height="7" fill="${hair}"/><rect x="38" y="13" width="7" height="9" fill="${hair}"/><rect x="12" y="8" width="30" height="3" fill="${accent}"/>` :
    id === "kit" ? `<rect x="10" y="8" width="34" height="8" fill="${accent}"/><rect x="8" y="14" width="37" height="4" fill="#d7e6f6"/><rect x="12" y="18" width="7" height="4" fill="${hair}"/><rect x="35" y="18" width="7" height="4" fill="${hair}"/>` :
    id === "wren" ? `<rect x="10" y="9" width="34" height="8" fill="${hair}"/><rect x="8" y="15" width="8" height="10" fill="${hair}"/><rect x="39" y="15" width="7" height="11" fill="${hair}"/><rect x="11" y="8" width="32" height="3" fill="${accent}"/>` :
    id === "rowan" ? `<rect x="10" y="9" width="34" height="10" fill="${hair}"/><rect x="8" y="15" width="8" height="9" fill="${hair}"/><rect x="39" y="15" width="7" height="12" fill="${hair}"/><rect x="14" y="8" width="7" height="4" fill="#8a5b42"/><rect x="31" y="8" width="8" height="4" fill="#8a5b42"/>` :
    id === "piper" ? `<rect x="6" y="11" width="42" height="5" fill="#6b4a2e"/><rect x="13" y="6" width="28" height="9" fill="#805936"/><rect x="16" y="7" width="22" height="4" fill="#946943"/><rect x="9" y="16" width="7" height="11" fill="${hair}"/><rect x="38" y="16" width="7" height="10" fill="${hair}"/>` :
    `<rect x="11" y="9" width="32" height="8" fill="${hair}"/>`;
  const beard = id === "marlow" ? `<rect x="17" y="32" width="21" height="7" fill="${hair}"/><rect x="21" y="38" width="13" height="3" fill="${hair}"/>` : id === "rowan" ? `<rect x="17" y="31" width="21" height="10" fill="${hair}"/><rect x="21" y="39" width="13" height="3" fill="${hair}"/>` : "";
  const glasses = id === "marlow" ? `<rect x="15" y="25" width="11" height="7" fill="#c9d7e5" fill-opacity=".25" stroke="#38364e" stroke-width="2"/><rect x="29" y="25" width="11" height="7" fill="#c9d7e5" fill-opacity=".25" stroke="#38364e" stroke-width="2"/><rect x="26" y="27" width="3" height="2" fill="#38364e"/>` : id === "kit" ? `<rect x="15" y="25" width="10" height="5" fill="none" stroke="#3c4050" stroke-width="2"/><rect x="29" y="25" width="10" height="5" fill="none" stroke="#3c4050" stroke-width="2"/><rect x="25" y="27" width="5" height="2" fill="#3c4050"/>` : "";
  const outfit = id === "marlow" ? `<rect x="17" y="45" width="21" height="27" fill="#24356d"/><rect x="17" y="45" width="21" height="5" fill="#526cb8"/><rect x="20" y="50" width="5" height="19" fill="#314986"/><rect x="29" y="50" width="5" height="19" fill="#182654"/><rect x="25" y="49" width="4" height="20" fill="#e7e8df"/>` :
    id === "juniper" ? `<rect x="17" y="45" width="21" height="27" fill="#664091"/><rect x="17" y="45" width="21" height="5" fill="#a775d6"/><rect x="22" y="49" width="11" height="20" fill="#eee8e7"/><rect x="17" y="50" width="5" height="20" fill="#8153af"/><rect x="33" y="50" width="5" height="20" fill="#4e2d78"/>` :
    id === "kit" ? `<rect x="17" y="45" width="21" height="27" fill="#285c9d"/><rect x="17" y="45" width="21" height="5" fill="#5a9cdb"/><rect x="21" y="50" width="13" height="16" fill="#3475b8"/><rect x="23" y="61" width="10" height="7" fill="#225084"/>` :
    id === "wren" ? `<rect x="18" y="48" width="20" height="22" fill="#e09bbd"/><rect x="19" y="52" width="18" height="4" fill="#f4c5de"/><rect x="22" y="51" width="3" height="19" fill="#f4c5de"/><rect x="31" y="51" width="3" height="19" fill="#f4c5de"/><rect x="11" y="48" width="6" height="20" fill="#f3f0e8"/><rect x="37" y="48" width="6" height="20" fill="#f3f0e8"/>` :
    id === "rowan" ? `<rect x="17" y="45" width="21" height="27" fill="#78437c"/><rect x="17" y="45" width="21" height="5" fill="#b460a5"/><rect x="21" y="49" width="13" height="22" fill="#6b4430"/><rect x="24" y="50" width="3" height="18" fill="#8d6143"/><rect x="31" y="50" width="3" height="18" fill="#4b3028"/>` :
    id === "tove" ? `<rect x="17" y="45" width="21" height="27" fill="#8faee0"/><rect x="17" y="45" width="21" height="5" fill="#b5c9ed"/><rect x="20" y="50" width="15" height="20" fill="#9fbbe7"/><path d="M20 54h15M20 62h15M25 50v20M32 50v20" stroke="#dce8ff" stroke-width="2"/>` :
    `<rect x="17" y="45" width="21" height="27" fill="#526d55"/><rect x="17" y="45" width="21" height="5" fill="#88a773"/><rect x="21" y="49" width="13" height="22" fill="#765132"/><rect x="23" y="50" width="3" height="20" fill="#936943"/><rect x="31" y="50" width="3" height="20" fill="#4e3728"/>`;
  const legwear = id === "wren" ? "#e09bbd" : id === "kit" ? "#6b4430" : id === "rowan" || id === "piper" ? "#765132" : "#31313d";
  const accessories = id === "kit" ? `<rect x="22" y="49" width="3" height="12" fill="#e5eef6"/><rect x="30" y="49" width="3" height="12" fill="#e5eef6"/><rect x="24" y="58" width="7" height="3" fill="#e5eef6"/>` : id === "tove" ? `<rect x="21" y="49" width="13" height="4" fill="#eef4ff"/><rect x="25" y="53" width="5" height="14" fill="#dce8ff"/>` : id === "marlow" ? `<rect x="25" y="49" width="4" height="11" fill="#f0c74f"/><rect x="22" y="50" width="10" height="3" fill="#f0c74f"/>` : id === "piper" ? `<rect x="22" y="44" width="10" height="5" fill="#d8a348"/><rect x="24" y="46" width="6" height="3" fill="#a8654e"/><rect x="20" y="58" width="4" height="3" fill="#d8a348"/><rect x="30" y="58" width="4" height="3" fill="#d8a348"/>` : "";
  return `<svg class="avatar ${size}" viewBox="0 0 54 82" role="img" aria-label="${id} pixel character" shape-rendering="crispEdges"><rect x="9" y="47" width="8" height="24" fill="${coat}"/><rect x="38" y="47" width="8" height="24" fill="${coat}"/><rect x="11" y="66" width="7" height="7" fill="${skin}"/><rect x="37" y="66" width="7" height="7" fill="${skin}"/>${outfit}<rect x="19" y="70" width="7" height="11" fill="${legwear}"/><rect x="30" y="70" width="7" height="11" fill="${legwear}"/><rect x="13" y="16" width="28" height="25" fill="${skin}"/>${hairBack}<rect x="14" y="18" width="28" height="22" fill="${skin}"/><rect x="14" y="18" width="4" height="20" fill="#00000012"/><rect x="38" y="18" width="4" height="20" fill="#ffffff18"/>${hairFront}<rect x="20" y="27" width="3" height="3" fill="#252b3c"/><rect x="32" y="27" width="3" height="3" fill="#252b3c"/>${beard}${glasses}<rect x="25" y="34" width="5" height="2" fill="#b87973"/>${accessories}</svg>`;
}

async function api(url, options = {}) {
  const requestRepo = state.repo;
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(state.apiToken ? { "X-Agent-Team-Token": state.apiToken } : {}), ...(state.repo ? { "X-Agent-Team-Repository": encodeURIComponent(state.repo) } : {}), ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  if (url !== "/api/bootstrap" && requestRepo !== state.repo) throw new Error("The repository changed while this request was working. Refresh the workshop.");
  return data;
}

function notify(message, error = false) {
  const notice = $("#notice"); notice.textContent = message; notice.className = `notice visible ${error ? "error" : ""}`;
  clearTimeout(notify.timer); notify.timer = setTimeout(() => notice.classList.remove("visible"), 6500);
}

async function refresh(quiet = false) {
  try {
    const version = workspaceVersion;
    const data = await api("/api/bootstrap");
    if (version !== workspaceVersion) return;
    const repositoryChanged = Boolean(state.repo && state.repo !== data.repo);
    const previousRuns = state.runs;
    const previousSignature = JSON.stringify(previousRuns.map((run) => ({ id: run.id, status: run.status, plan: run.plan, tasks: run.tasks })));
    const goalDraft = $("#goal-input")?.value;
    const answerDraft = $("#answer-form input")?.value;
    Object.assign(state, data);
    if (repositoryChanged) { state.selectedRun = null; state.review = null; dismissedPrompts.clear(); $("#review-modal")?.remove(); $("#repo-modal")?.remove(); $("#git-modal")?.remove(); $("#input-prompt")?.remove(); }
    if (!state.selectedRun || !state.runs.some((item) => item.id === state.selectedRun)) state.selectedRun = state.runs[0]?.id || null;
    renderSidebar();
    if (!quiet || repositoryChanged || previousSignature !== JSON.stringify(state.runs.map((run) => ({ id: run.id, status: run.status, plan: run.plan, tasks: run.tasks })))) {
      renderMain();
      if (!repositoryChanged && goalDraft !== undefined && $("#goal-input")) $("#goal-input").value = goalDraft;
      if (!repositoryChanged && answerDraft !== undefined && $("#answer-form input")) $("#answer-form input").value = answerDraft;
    } else if (currentRun()) void loadEvents(currentRun().id);
    if (!quiet || repositoryChanged) renderPanel();
    if (state.view === "bench") void loadBench();
    const before = previousRuns.find((item) => item.id === state.selectedRun);
    const after = currentRun();
    if (quiet && before && after && before.status !== after.status) {
      if (after.status === "blocked") notify("Someone at the workshop needs your answer.");
      if (after.status === "awaiting-review") notify("The team finished. Your review is ready.");
    }
    $("#repo-name").textContent = data.repo.split(/[\\/]/).pop();
    $("#repo-button-name").textContent = data.repo.split(/[\\/]/).pop();
    $("#repo-button").title = `Switch repository · ${data.repo}`;
  } catch (error) { if (!quiet) notify(error.message, true); }
}

function renderSidebar() {
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  $("#page-title").textContent = state.view === "library" ? "SHARED LIBRARY" : state.view === "bench" ? "TEST BENCH" : state.view === "status" ? "STATUS BOARD" : "WORKSHOP";
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

function agentStateClass(id, run) {
  const status = agentStatus(id, run);
  if (status === "Needs your input") return "attention";
  if (["Working on a task", "Planning the goal", "Researching", "Preview running"].includes(status)) return "working";
  if (["In review", "QA complete"].includes(status)) return "review";
  return "idle";
}

function statusEventRows() {
  const { persona, event, run } = state.statusFilters;
  const selectedRun = currentRun();
  return state.events.filter((item) =>
    (persona === "all" || item.persona === persona) &&
    (event === "all" || item.event === event) &&
    (run === "selected" || run === "all" || !selectedRun || run === selectedRun.id)
  ).slice().reverse();
}

function renderStatusEvents() {
  const node = $("#status-event-list"); if (!node) return;
  const events = statusEventRows();
  node.innerHTML = events.length ? events.map((item, index) => {
    const color = eventColor(item.persona);
    const files = item.files?.length ? `<div class="status-event-files">${item.files.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>` : "";
    return `<details class="status-event" style="--event-accent:${color}" ${index === 0 ? "open" : ""}><summary><span class="status-event-mark" aria-hidden="true"></span><span class="status-event-main"><strong>${escapeHtml(eventName(item.persona))}</strong><span class="status-event-type">${escapeHtml(item.event.replaceAll("-", " "))}</span><span class="status-event-summary">${escapeHtml(item.detail)}</span></span><time>${fmt(item.at)}</time><span class="status-event-chevron">⌄</span></summary><div class="status-event-detail"><p>${escapeHtml(item.detail)}</p>${files}<small>${escapeHtml(item.runId ? `Run ${item.runId}${item.taskId ? ` · ${item.taskId}` : ""}` : "Live run event")}</small></div></details>`;
  }).join("") : `<div class="status-empty"><span>◌</span><h3>No events match these filters.</h3><p>New activity will appear here as the selected run moves forward.</p></div>`;
  const count = $("#status-event-count"); if (count) count.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
}

function closeEventStream() {
  if (state.eventStream) { state.eventStream.close(); state.eventStream = null; }
}

function setStatusConnection(message, offline = false) {
  const badge = $("#status-connection");
  badge?.classList.toggle("offline", offline);
  const label = badge?.querySelector("small");
  if (label) label.textContent = message;
}

async function loadStatusEvents() {
  closeEventStream();
  setStatusConnection("Connecting…");
  const runId = ["selected", "all"].includes(state.statusFilters.run) ? state.selectedRun : state.statusFilters.run;
  const run = runId === "all" ? currentRun() : state.runs.find((item) => item.id === runId);
  if (!run) { state.events = []; renderStatusEvents(); setStatusConnection("Choose a run", true); return; }
  try {
    state.events = await api(`/api/runs/${encodeURIComponent(run.id)}/events?limit=25`);
    if (state.view !== "status") return;
    renderStatusEvents();
    state.eventStream = new EventSource(`/api/runs/${encodeURIComponent(run.id)}/events/stream`);
    state.eventStream.addEventListener("run-event", (message) => {
      try { state.events = [...state.events, JSON.parse(message.data)].slice(-25); renderStatusEvents(); } catch { /* ignore malformed event */ }
    });
    state.eventStream.onerror = () => setStatusConnection("Reconnecting…", true);
    state.eventStream.onopen = () => setStatusConnection("Connected");
  } catch (error) {
    setStatusConnection("Unavailable", true);
    const node = $("#status-event-list"); if (node) node.innerHTML = `<p class="subtle">${escapeHtml(error.message)}</p>`;
  }
}

function renderStatusBoard() {
  closeEventStream();
  const run = currentRun();
  const eventTypes = [...new Set(state.events.map((item) => item.event))].sort();
  const personaOptions = state.profiles.map((item) => `<option value="${item.id}" ${state.statusFilters.persona === item.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
  const eventOptions = eventTypes.map((item) => `<option value="${escapeHtml(item)}" ${state.statusFilters.event === item ? "selected" : ""}>${escapeHtml(item.replaceAll("-", " "))}</option>`).join("");
  const runOptions = state.runs.slice(0, 12).map((item) => `<option value="${escapeHtml(item.id)}" ${state.statusFilters.run === item.id ? "selected" : ""}>${escapeHtml(item.goal)}</option>`).join("");
  $("#main-content").innerHTML = `<section class="status-page"><div class="status-hero"><div><div class="eyebrow"><span class="live-mark"></span> THE WORKSHOP SIGNAL</div><h1>Status board</h1><p>Follow every logged move as the team turns a goal into a build.</p></div><div class="status-live-indicator" id="status-connection"><span></span><strong>LIVE FEED</strong><small>SSE connected</small></div></div><section class="status-card"><div class="status-toolbar"><div><small class="status-kicker">EVENT STREAM</small><h2>${escapeHtml(run?.goal || "Select a run")}</h2></div><span id="status-event-count" class="status-count">Loading…</span></div><div class="status-filters"><label>PERSONA<select id="status-persona-filter"><option value="all">Everyone</option>${personaOptions}</select></label><label>EVENT<select id="status-event-filter"><option value="all">All event types</option>${eventOptions}</select></label><label>RUN<select id="status-run-filter"><option value="selected">Selected run</option><option value="all">Current run</option>${runOptions}</select></label></div><div id="status-event-list" class="status-event-list"><p class="subtle">Loading live events…</p></div></section></section>`;
  void loadStatusEvents();
}

function renderMain() {
  const main = $("#main-content");
  if (state.view === "library") {
    $("#input-prompt")?.remove();
    main.innerHTML = `<section class="library-page"><div class="eyebrow">THE SHARED SHELF</div><h1>What the team knows, together.</h1><p>Decisions and verified repository notes are added after you review and merge a finished goal. Each agent also keeps a personal journal at their desk.</p><div class="library-paper"><div class="paper-header"><span>▤</span> REPOSITORY LIBRARY</div><pre>${escapeHtml(state.library || "The shelves are quiet for now. Complete and merge a goal to start the shared library.")}</pre></div></section>`;
    return;
  }
  if (state.view === "bench") { renderBench(); return; }
  if (state.view === "status") { renderStatusBoard(); return; }
  const run = currentRun();
  const blocked = run?.tasks.find((task) => task.status === "blocked");
  const piperNeeds = run?.status === "blocked" && run.preview?.issue && !blocked;
  if ((!blocked && !piperNeeds) || $("#input-prompt")?.dataset.run !== run.id) $("#input-prompt")?.remove();
  const worker = blocked && run?.plan?.tasks.find((task) => task.id === blocked.id)?.worker;
  main.innerHTML = `
    <section class="hero"><div class="hero-copy"><div class="eyebrow"><span class="spark">✦</span> A SMALL FACTORY FOR BIG IDEAS</div><h1>Good things are<br><em>built together.</em></h1><p>Give your team a goal, watch each desk light up, and step in when they need you.</p></div><div class="hero-cube" aria-hidden="true"><div class="cube-top"></div><div class="cube-left"></div><div class="cube-right"></div><span>✦</span></div></section>
    ${state.appleProject && !state.remoteHost.enabled ? `<button class="mac-host-banner" id="configure-mac-host"><span>⌘</span><strong>Apple project detected</strong><small>Connect a Mac Build Host so the team can run Xcode and simulator checks.</small><b>Set up →</b></button>` : ""}
    <form id="goal-form" class="goal-composer"><div class="composer-icon">✎</div><label for="goal-input"><strong>What should the team build?</strong><span>Describe a coding goal for this repository.</span></label><input id="goal-input" name="goal" maxlength="4000" placeholder="e.g. Add a friendly empty state to the dashboard" required><button class="primary-button" type="submit">Start goal <span>↗</span></button></form>
    ${blocked ? `<section class="summons" role="alert"><div class="summons-portrait">${avatar(worker || "marlow", "small")}</div><div class="summons-copy"><span class="eyebrow">A QUESTION FROM ${escapeHtml(worker || "THE TEAM")}</span><h2>${escapeHtml(profile(worker)?.name || "The team")} needs your help.</h2><p>${escapeHtml(blocked.error || "This task needs a decision before work can continue.")}</p><form id="answer-form"><input name="answer" maxlength="8000" aria-label="Your answer" placeholder="Type your answer or direction…" required><button class="primary-button">Send answer →</button></form></div></section>` : piperNeeds ? `<section class="summons" role="alert"><div class="summons-portrait">${avatar("piper", "small")}</div><div class="summons-copy"><span class="eyebrow">PIPER AT THE TEST BENCH</span><h2>Piper needs your help.</h2><p>${escapeHtml(run.preview.issue)}</p><button class="primary-button" data-view="bench">Open Test Bench →</button></div></section>` : ""}
    ${run?.status === "awaiting-review" ? `<section class="review-banner"><div><span class="eyebrow">${run.baseCommit === state.head ? "READY FOR YOU" : "PAST RUN"}</span><h2>${run.baseCommit === state.head ? "The team has finished building." : "This build is still here to review."}</h2><p>${run.baseCommit === state.head ? "Review the changes and checks before merging into your main checkout." : "Your checkout has moved on. Open review to save local work and update this build to the latest code."}</p></div><button class="secondary-button" id="review-button">Open review ↗</button></section>` : ""}
    <section class="section-heading"><div><div class="eyebrow"><span class="live-mark"></span> MEET THE TEAM</div><h2>The workshop floor <span class="head-spark">✦</span></h2></div><p>Click a desk to chat, set its model, or open its journal.</p></section>
    <div class="factory-floor">${state.profiles.map((item, index) => { const status = agentStatus(item.id, run); return `<button class="station station-${item.id} ${state.selectedAgent === item.id ? "picked" : ""} ${agentStateClass(item.id, run)}" data-agent="${item.id}" style="--accent:${colors[item.id][0]};--order:${index}"><span class="station-top"><span class="station-number">0${index + 1} / 0${state.profiles.length}</span><span class="station-signal"><span class="station-light ${status === "Needs your input" ? "urgent" : ""}"></span><span class="signal-label">${status === "Needs your input" ? "NEEDS YOU" : status === "At their desk" ? "STANDBY" : "LIVE"}</span></span></span><span class="station-scene"><span class="scene-glow"></span><span class="monitor"><span class="monitor-lines"><i></i><i></i><i></i></span></span>${avatar(item.id)}<span class="desk"><span class="desk-top"></span><span class="desk-front"></span></span></span><span class="station-info"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.specialty)}</small></span><span class="station-foot"><span class="tiny-dot"></span>${escapeHtml(status)}<span class="station-open">↗</span></span></button>`; }).join("")}</div>
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
  $("#detail-panel").innerHTML = `<div class="panel-head" style="--accent:${colors[item.id][0]}"><div class="panel-top"><span>PERSONAL DESK / 0${state.profiles.indexOf(item) + 1}</span><span class="panel-star">✦</span></div><div class="panel-person">${avatar(item.id, "panel-avatar")}<div><small>${escapeHtml(item.specialty)}</small><h2>${escapeHtml(item.name)}</h2><p>“${escapeHtml(moods[item.id])}”</p></div></div><div class="panel-tabs"><button class="${state.panelTab === "chat" ? "active" : ""}" data-tab="chat">Chat</button><button class="${state.panelTab === "journal" ? "active" : ""}" data-tab="journal">Journal</button><button class="${state.panelTab === "performance" ? "active" : ""}" data-tab="performance">Review</button><button class="${state.panelTab === "settings" ? "active" : ""}" data-tab="settings">Model</button></div></div>
    <div class="panel-body">${state.panelTab === "chat" ? `<div class="chat-window" id="chat-window">${chat.length ? chat.map((entry) => `<div class="chat-bubble ${entry.role}"><span>${entry.role === "user" ? "YOU" : escapeHtml(item.name.toUpperCase())}</span><p>${escapeHtml(entry.text)}</p><small>${fmt(entry.at)}</small></div>`).join("") : `<div class="chat-empty"><span>✳</span><h3>Pull up a chair.</h3><p>Ask ${escapeHtml(item.name)} about the repository, a goal, or what they've been working on.</p></div>`}</div><form id="chat-form" class="chat-form"><textarea name="message" rows="2" maxlength="8000" placeholder="Message ${escapeHtml(item.name)}…" required></textarea><button class="send-button" aria-label="Send message">↗</button></form><p class="panel-hint">Conversations are saved to ${escapeHtml(item.name)}'s personal desk.</p>` : ""}
    ${state.panelTab === "journal" ? `<div class="journal-intro"><span>▤</span><h3>${escapeHtml(item.name)}'s journal</h3><p>A personal space for character, reminders, and the work they've done.</p></div><form id="journal-form"><label>PERSONALITY & TRAITS<textarea name="traits" rows="4" maxlength="4000" placeholder="How does this agent approach work?">${escapeHtml(item.traits)}</textarea></label><label>PINNED MEMORY<textarea name="memory" rows="6" maxlength="12000" placeholder="Facts or preferences this agent should carry into future work…">${escapeHtml(item.memory)}</textarea></label><button class="secondary-button" type="submit">Save journal</button></form><div class="journal-history"><h4>SEARCHABLE TIMELINE</h4><form id="timeline-form" class="timeline-form"><input name="query" maxlength="200" placeholder="Search work, features, or decisions…" aria-label="Search timeline"><div class="timeline-dates"><label>FROM<input name="from" type="date"></label><label>TO<input name="to" type="date"></label></div><details><summary>More filters</summary><input name="feature" maxlength="200" placeholder="Feature or task" aria-label="Feature filter"><input name="file" maxlength="300" placeholder="File path" aria-label="File filter"></details><button class="secondary-button" type="submit">Search journal</button></form><div id="timeline-list"><p class="subtle">Loading the timeline…</p></div></div>` : ""}
    ${state.panelTab === "performance" ? `<div class="performance-intro"><span>◎</span><h3>Performance review</h3><p>Run two role-specific exercises. A second agent scores the answers, then ${escapeHtml(item.name)} turns the feedback into guidance for future work.</p><button class="primary-button" id="performance-review-button">Run performance review</button></div>${item.performanceGuidance ? `<div class="coaching-note"><small>CURRENT SELF-IMPROVEMENT NOTE</small><p>${escapeHtml(item.performanceGuidance)}</p></div>` : ""}<div class="evaluation-history">${(item.evaluations || []).length ? item.evaluations.map((evaluation) => `<article class="evaluation-card"><div class="evaluation-score"><strong>${escapeHtml(evaluation.score)}</strong><span>/ 100</span></div><div class="evaluation-copy"><time>${fmt(evaluation.at)} · reviewed by ${escapeHtml(profile(evaluation.evaluator)?.name || evaluation.evaluator)}</time><p>${escapeHtml(evaluation.summary)}</p><details><summary>Feedback and reflection</summary><strong>Strengths</strong><ul>${evaluation.strengths.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul><strong>Improve next</strong><ul>${evaluation.improvements.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul><p>${escapeHtml(evaluation.reflection)}</p></details></div></article>`).join("") : `<p class="subtle">No reviews yet. The first one will establish a baseline.</p>`}</div>` : ""}
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

async function watchJob(id, reviewRunId) {
  const timer = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${id}`);
      await refresh(true);
      if (job.runId && state.selectedRun !== job.runId) { const previous = state.selectedRun; state.selectedRun = job.runId; if (previous) void api(`/api/runs/${previous}/preview/stop`, { method: "POST", body: "{}" }); renderSidebar(); renderMain(); }
      if (job.status !== "running") {
        clearInterval(timer); await refresh();
        if (job.status === "error") notify(job.error || "The run stopped.", true);
        else notify("The team has finished this step. Take a look at the task wall.");
        if (reviewRunId && state.selectedRun === reviewRunId) await openReview();
      }
    } catch { clearInterval(timer); }
  }, 2500);
}

async function openReview() {
  let run = currentRun(); if (!run) return;
  try {
    state.review = await api(`/api/runs/${run.id}/review`);
    if (currentRun()?.id !== run.id) return;
    run = state.review.state;
    $("#review-modal")?.remove();
    const modal = document.createElement("div"); modal.className = "modal-backdrop"; modal.id = "review-modal";
    modal.innerHTML = `<div class="review-modal" role="dialog" aria-modal="true" aria-label="Review team changes"><div class="review-header"><div><span class="eyebrow">BEFORE IT JOINS YOUR MAIN BRANCH</span><h2>Review the build</h2><p>${escapeHtml(run.goal)}</p></div><button class="icon-button" data-close="review" aria-label="Close review">✕</button></div><div class="review-scroll"><div class="review-summary"><h3>Marlow's note</h3><p>${escapeHtml(run.summary || "No summary yet.")}</p></div>${run.tasks.map((task) => `<div class="review-task"><strong>${escapeHtml(taskLabel(task, run))}</strong><span class="status-chip ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span><p><b>Review:</b> ${escapeHtml(task.review || "Pending")}</p><p><b>QA:</b> ${escapeHtml(task.qa || "Pending")}</p><div class="check-list">${(task.checks || []).map((check) => checkMarkup(check, run.id)).join("")}</div></div>`).join("")}<h3>Code changes</h3><pre class="diff">${escapeHtml(state.review.diff || "No staged diff to show.")}</pre>${run.memoryNote ? `<div class="review-summary"><h3>Tove's pending library note</h3><p>${escapeHtml(run.memoryNote)}</p></div>` : ""}</div><div class="review-actions"><span>${run.baseCommit === state.head ? "Merge is local. Nothing is pushed." : "This run began from an older checkout and cannot merge here."}</span><button class="primary-button" id="merge-button" ${run.status !== "awaiting-review" || run.baseCommit !== state.head ? "disabled" : ""}>Merge reviewed work →</button></div></div>`;
    const recovery = document.createElement("section"); recovery.className = "git-recovery";
    recovery.innerHTML = gitRecoveryMarkup(state.review.readiness.git, state.review.readiness, run);
    modal.querySelector(".review-scroll").prepend(recovery);
    if (run.integrationHistory?.length) {
      const note = document.createElement("p"); note.className = "subtle";
      note.textContent = "The task review and QA notes below describe the original build. Review the combined diff and the updated checks above before merging.";
      recovery.after(note);
    }
    const ready = state.review.readiness.canMerge && !Object.values(state.jobs).some((job) => job.status === "running");
    modal.querySelector(".review-actions").innerHTML = `<span>${ready ? "Ready to merge locally into " + escapeHtml(state.review.readiness.git.branch) + "." : "Merge is unavailable. Use the Git actions above to clear the listed blockers."}</span><button class="primary-button" id="merge-button" ${ready ? "" : "disabled"}>${ready ? "Merge reviewed work →" : "Merge unavailable"}</button>`;
    document.body.append(modal);
  } catch (error) { notify(error.message, true); }
}

function checkMarkup(check, runId) {
  const artifacts = (check.artifacts || []).map((artifact) => {
    const url = `/api/runs/${encodeURIComponent(runId)}/check-artifact?path=${encodeURIComponent(artifact.path)}&token=${encodeURIComponent(state.apiToken)}`;
    return artifact.mimeType.startsWith("image/") ? `<a href="${url}" target="_blank"><img src="${url}" alt="${escapeHtml(artifact.name)}"></a>` : `<a href="${url}" target="_blank">${escapeHtml(artifact.name)}</a>`;
  }).join("");
  const detail = check.output || check.summary || artifacts ? `<details class="check-details"><summary>${escapeHtml(check.name)} · ${escapeHtml(check.status)}${check.executor ? ` on ${escapeHtml(check.executor)}` : ""}</summary>${check.summary ? `<pre>${escapeHtml(check.summary)}</pre>` : ""}${check.output ? `<pre>${escapeHtml(check.output)}</pre>` : ""}${artifacts ? `<div class="check-artifacts">${artifacts}</div>` : ""}</details>` : "";
  return `<div><span class="check ${escapeHtml(check.status)}">${escapeHtml(check.name)} · ${escapeHtml(check.status)}</span>${detail}</div>`;
}

function renderSecretMappings() {
  const container = $("#remote-secret-mappings"); if (!container) return;
  const entries = Object.entries(optionSecrets);
  container.innerHTML = entries.length ? entries.map(([variable, name]) => `<div class="secret-map"><code>${escapeHtml(variable)}</code><span>→</span><strong>${escapeHtml(name)}</strong><button type="button" data-remove-mac-secret="${escapeHtml(variable)}" aria-label="Remove ${escapeHtml(variable)}">✕</button></div>`).join("") : `<p class="subtle">No build secrets mapped for this repository.</p>`;
}

function renderRemoteReadiness(result) {
  const container = $("#remote-readiness"); if (!container) return;
  container.innerHTML = (result.items || []).map((item) => `<div class="remote-status-item ${item.ok ? "ok" : "bad"}"><strong>${item.ok ? "✓" : "!"} ${escapeHtml(item.name)}</strong><span>${escapeHtml(item.detail)}</span></div>`).join("");
}

async function openOptions() {
  const data = await api("/api/options/mac-host");
  optionSecrets = { ...(data.project.secrets || {}) };
  $("#options-modal")?.remove();
  const modal = document.createElement("div"); modal.className = "modal-backdrop"; modal.id = "options-modal";
  modal.innerHTML = `<div class="remote-modal" role="dialog" aria-modal="true" aria-label="Workshop options"><div class="review-header"><div><span class="eyebrow">WORKSHOP OPTIONS</span><h2>Mac Build Host</h2><p>Keep the workshop on Windows and send Apple builds to your Mac automatically.</p></div><button class="icon-button" data-close="options" aria-label="Close options">✕</button></div><div class="remote-body">
    <section class="remote-card"><h3>Connection</h3><p>Use an SSH alias or user@host that already works with key authentication.</p><form id="mac-host-form"><div class="remote-grid"><label>SSH TARGET<input name="target" value="${escapeHtml(data.host.target)}" placeholder="builder@mac.local" required></label><label>PORT<input name="port" type="number" min="1" max="65535" value="${escapeHtml(data.host.port || "")}" placeholder="22"></label><label>REMOTE CACHE ROOT<input name="root" value="${escapeHtml(data.host.root)}" required></label></div><label class="remote-toggle"><input name="enabled" type="checkbox" ${data.host.enabled ? "checked" : ""}> Use this Mac automatically for Apple checks</label><div class="remote-actions"><button class="primary-button" type="submit">Save host</button><button class="secondary-button" type="button" id="mac-host-test">${data.host.target ? "Test saved connection" : "Test connection"}</button><span class="remote-test-note">Checks the Mac without starting an agent job or uploading your project.</span></div></form><div id="remote-readiness" class="remote-status"></div></section>
    <section class="remote-card"><h3>This repository</h3><p>${data.appleChecks.length ? `Detected: ${data.appleChecks.map(escapeHtml).join(" · ")}` : "No Apple checks are currently detected."}</p><form id="mac-project-form"><label>PREPARATION COMMAND<textarea name="setupCommand" rows="2" placeholder="Optional, for example: bundle exec pod install">${escapeHtml(data.project.setupCommand || "")}</textarea></label><button class="secondary-button" type="submit">Save project setup</button></form></section>
    <section class="remote-card"><h3>Mac Keychain secrets</h3><p>Values travel over SSH and are stored in the Mac user's login Keychain. Only the mapping names remain on Windows.</p><div id="remote-secret-mappings" class="secret-mappings"></div><form id="mac-secret-form" class="remote-secret-form"><label>VARIABLE<input name="variable" placeholder="API_BASE_URL" required></label><label>KEYCHAIN NAME<input name="name" placeholder="ios/api-base" required></label><label>VALUE<input name="value" type="password" required></label><button class="secondary-button" type="submit">Save & map</button></form></section>
  </div></div>`;
  document.body.append(modal); renderSecretMappings();
}

function gitRecoveryMarkup(status, readiness, run) {
  const busy = Object.values(state.jobs).some((job) => job.status === "running");
  const disabled = busy ? "disabled" : "";
  const reasons = readiness?.reasons || [];
  const checks = run?.integration?.checks || run?.integrationChecks || [];
  return `<div class="git-status-head"><div><span class="eyebrow">GIT WORKSPACE</span><h3>${readiness ? readiness.canMerge ? "Ready to merge" : "Let's clear the merge blockers" : "Save your local work"}</h3></div><button class="secondary-button" id="git-refresh">Refresh Git status</button></div><p class="git-location">Branch <strong>${escapeHtml(status.branch)}</strong> · commit ${escapeHtml(status.head.slice(0, 8))}</p>${reasons.length ? `<ul class="git-blockers">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : ""}${busy ? `<p class="git-blockers">Wait for the current work to finish before using Git actions.</p>` : ""}
    ${status.changes.length ? `<details class="git-local-changes" open><summary>${status.changes.length} local file changes</summary><form id="git-commit-form" data-head="${escapeHtml(status.head)}"><p>Select the files to save in a local commit. This commits on ${escapeHtml(status.branch)}.</p><div class="git-files">${status.changes.map((file) => { const secret = /(^|[\\/])\.env(?:\.|$)/.test(file.path) && !file.path.endsWith(".env.example"); return `<label><input type="checkbox" name="files" value="${escapeHtml(file.path)}" ${secret ? "disabled" : "checked"}><code>${escapeHtml(file.status)} ${escapeHtml(file.path)}</code>${secret ? " · kept local" : ""}</label>`; }).join("")}</div>${status.diff ? `<details><summary>Review local changes</summary><pre class="diff">${escapeHtml(status.diff)}</pre></details>` : ""}<label class="git-message">Commit message<input name="message" maxlength="500" placeholder="Describe the changes you're saving" required></label><button class="primary-button" ${disabled}>Save selected files as a commit</button></form></details>` : `<p class="git-clean">✓ Your repository has no unsaved changes.</p>`}
    ${run?.status === "awaiting-review" && readiness?.stale && !run.integration ? `<div class="git-next-step"><p>Update this run in a new worktree using your current repository commit. Both versions are kept for review, and detected checks run again.</p><button class="secondary-button" id="git-update-run" ${busy || status.changes.length || readiness.stagingDirty ? "disabled" : ""}>Update run to latest code</button></div>` : ""}
    ${run?.integration ? `<div class="git-next-step"><p>Update worktree: <code>${escapeHtml(readiness.integrationPath)}</code></p>${readiness.conflicts.map((conflict) => `<details class="git-conflict"><summary>Conflict: ${escapeHtml(conflict.path)}</summary><p>Choose one whole file version, or edit the combined file in the update worktree and stage your resolution there.</p><div class="git-versions"><div><h4>Your repository version</h4><pre>${escapeHtml(conflict.current)}</pre><button class="secondary-button" data-conflict="${escapeHtml(conflict.path)}" data-choice="current" ${disabled}>Keep repository file</button></div><div><h4>Team version</h4><pre>${escapeHtml(conflict.team)}</pre><button class="secondary-button" data-conflict="${escapeHtml(conflict.path)}" data-choice="team" ${disabled}>Keep team file</button></div></div></details>`).join("")}<button class="primary-button" id="git-finish-update" ${busy || readiness.conflicts.length ? "disabled" : ""}>Finish update and rerun checks</button></div>` : ""}
    ${checks.length ? `<div class="git-next-step"><h4>Checks on the combined code</h4>${checks.map((check) => `<details class="git-check ${escapeHtml(check.status)}"><summary>${escapeHtml(check.name)} · ${escapeHtml(check.status)}</summary><pre>${escapeHtml(check.output)}</pre></details>`).join("")}</div>` : ""}
    ${run?.needsPreviewReview ? `<div class="git-next-step"><p>The updated interface needs Wren's review before merging. This uses your selected models.</p><button class="primary-button" id="git-review-preview" ${disabled}>Review updated Test Bench</button></div>` : ""}`;
}

async function openGitTools() {
  try {
    const status = await api("/api/git/status");
    $("#git-modal")?.remove();
    const modal = document.createElement("div"); modal.className = "modal-backdrop"; modal.id = "git-modal";
    modal.innerHTML = `<div class="repo-modal" role="dialog" aria-modal="true" aria-label="Git tools"><div class="review-header"><div><span class="eyebrow">${escapeHtml(state.repo.split(/[\\/]/).pop())}</span><h2>Git tools</h2><p>Save changes and prepare this repository for the next goal.</p></div><button class="icon-button" data-close="git" aria-label="Close Git tools">✕</button></div><div class="repo-picker-body">${gitRecoveryMarkup(status)}</div></div>`;
    document.body.append(modal);
  } catch (error) { notify(error.message, true); }
}

async function refreshGitView() { await refresh(); if ($("#review-modal")) await openReview(); else await openGitTools(); }

function openRepositoryPicker() {
  $("#repo-modal")?.remove();
  const modal = document.createElement("div"); modal.className = "modal-backdrop"; modal.id = "repo-modal";
  const repositories = state.repositories?.length ? state.repositories : [{ path: state.repo, name: state.repo.split(/[\\/]/).pop() }];
  modal.innerHTML = `<div class="repo-modal" role="dialog" aria-modal="true" aria-labelledby="repo-picker-title"><div class="review-header"><div><span class="eyebrow">YOUR LOCAL PROJECTS</span><h2 id="repo-picker-title">Choose a repository</h2><p>Each repository has its own goals, agent journals, shared library, and Test Bench.</p></div><button class="icon-button" data-close="repo" aria-label="Close repository picker">✕</button></div><div class="repo-picker-body"><div class="recent-repos">${repositories.map((repo) => `<button class="recent-repo ${repo.path === state.repo ? "current" : ""}" data-repo-path="${escapeHtml(repo.path)}"><span class="repo-glyph">${repo.path === state.repo ? "◆" : "◇"}</span><span><strong>${escapeHtml(repo.name)}</strong><small>${escapeHtml(repo.path)}</small></span>${repo.path === state.repo ? `<b>CURRENT</b>` : `<b>OPEN</b>`}</button>`).join("")}</div><form id="repo-form" class="repo-form"><label for="repo-path">ADD A LOCAL GIT REPOSITORY</label><div><input id="repo-path" name="path" maxlength="2000" placeholder="C:\\path\\to\\repository" autocomplete="off" required><button class="primary-button" type="submit">Open repository →</button></div><p>Paste the path to a Git repository that already has at least one commit.</p></form></div></div>`;
  document.body.append(modal);
  $("#repo-path")?.focus();
}

async function switchRepository(repoPath) {
  const result = await api("/api/repositories/select", { method: "POST", body: JSON.stringify({ path: repoPath }) });
  workspaceVersion++;
  state.repo = result.repo; state.repositories = result.repositories; state.selectedRun = null; state.review = null; state.view = "workshop";
  if ($("#goal-input")) $("#goal-input").value = "";
  if ($("#answer-form input")) $("#answer-form input").value = "";
  dismissedPrompts.clear(); $("#repo-modal")?.remove(); $("#review-modal")?.remove(); $("#git-modal")?.remove(); $("#input-prompt")?.remove();
  await refresh(); notify(`Opened ${state.repo.split(/[\\/]/).pop()}.`);
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button"); if (!target) return;
  if (target.dataset.view) { if (target.dataset.view !== "status") closeEventStream(); state.view = target.dataset.view; renderSidebar(); renderMain(); return; }
  if (target.dataset.run) { const previous = state.selectedRun; state.selectedRun = target.dataset.run; if (previous && previous !== state.selectedRun) void api(`/api/runs/${previous}/preview/stop`, { method: "POST", body: "{}" }); state.view = "workshop"; renderSidebar(); renderMain(); return; }
  if (target.dataset.agent) { state.selectedAgent = target.dataset.agent; state.panelTab = "chat"; renderMain(); renderPanel(); if (window.innerWidth <= 1050) $("#detail-panel").scrollIntoView({ behavior: "smooth" }); return; }
  if (target.dataset.tab) { state.panelTab = target.dataset.tab; renderPanel(); return; }
  if (target.dataset.close === "review") { $("#review-modal")?.remove(); return; }
  if (target.dataset.close === "repo") { $("#repo-modal")?.remove(); return; }
  if (target.dataset.close === "git") { $("#git-modal")?.remove(); return; }
  if (target.dataset.close === "options") { $("#options-modal")?.remove(); return; }
  if (target.dataset.close === "input") { dismissedPrompts.add(state.selectedRun); $("#input-prompt")?.remove(); return; }
  if (target.id === "repo-button") { openRepositoryPicker(); return; }
  if (target.id === "options-button") { try { await openOptions(); } catch (error) { notify(error.message, true); } return; }
  if (target.id === "configure-mac-host") { try { await openOptions(); } catch (error) { notify(error.message, true); } return; }
  if (target.id === "mac-host-test") {
    const form = $("#mac-host-form"); const data = new FormData(form); target.disabled = true; target.textContent = "Testing…";
    try {
      const result = await api("/api/options/mac-host/test", { method: "POST", body: JSON.stringify({ enabled: data.get("enabled") === "on", target: data.get("target"), port: data.get("port"), root: data.get("root") }) });
      renderRemoteReadiness(result); notify(result.ok ? "Mac Build Host is ready." : "The Mac needs attention before remote builds can run.", !result.ok);
    } catch (error) { notify(error.message, true); }
    finally { target.disabled = false; target.textContent = new FormData(form).get("target") ? "Test saved connection" : "Test connection"; }
    return;
  }
  if (target.dataset.removeMacSecret) {
    delete optionSecrets[target.dataset.removeMacSecret]; renderSecretMappings();
    try { await api("/api/options/mac-project", { method: "PUT", body: JSON.stringify({ setupCommand: new FormData($("#mac-project-form")).get("setupCommand"), secrets: optionSecrets }) }); notify("Secret mapping removed."); }
    catch (error) { notify(error.message, true); }
    return;
  }
  if (target.id === "git-tools-button") { await openGitTools(); return; }
  if (target.id === "git-refresh") { await refreshGitView(); return; }
  if (["git-update-run", "git-finish-update", "git-review-preview"].includes(target.id)) {
    target.disabled = true;
    const runId = currentRun()?.id;
    try {
      const action = { "git-update-run": "update", "git-finish-update": "finish-update", "git-review-preview": "review-preview" }[target.id];
      const result = await api(`/api/runs/${runId}/${action}`, { method: "POST", body: JSON.stringify({ head: state.review.readiness.git.head }) });
      watchJob(result.jobId, runId); notify("The run is being prepared. Its review will refresh when this step finishes.");
    } catch (error) { target.disabled = false; notify(error.message, true); }
    return;
  }
  if (target.dataset.conflict) {
    target.disabled = true;
    try { await api(`/api/runs/${currentRun().id}/resolve-conflict`, { method: "POST", body: JSON.stringify({ file: target.dataset.conflict, choice: target.dataset.choice }) }); await refreshGitView(); }
    catch (error) { target.disabled = false; notify(error.message, true); }
    return;
  }
  if (target.dataset.repoPath) { try { await switchRepository(target.dataset.repoPath); } catch (error) { notify(error.message, true); } return; }
  if (target.id === "refresh-button") { await refresh(); notify("Workshop refreshed."); }
  if (target.id === "review-button") await openReview();
  if (target.id === "performance-review-button") {
    const id = state.selectedAgent;
    target.disabled = true; target.textContent = "Running exercises…";
    try {
      const result = await api(`/api/personas/${id}/performance-review`, { method: "POST", body: "{}" });
      Object.assign(profile(id), result.profile); renderPanel(); notify(`${profile(id).name}'s performance review is complete.`);
    } catch (error) { target.disabled = false; target.textContent = "Run performance review"; notify(error.message, true); }
    return;
  }
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
    catch (error) { await openReview(); notify(error.message, true); }
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!["goal-form", "answer-form", "answer-pop-form", "chat-form", "journal-form", "timeline-form", "model-form", "secret-form", "requested-secret-form", "repo-form", "git-commit-form", "mac-host-form", "mac-project-form", "mac-secret-form"].includes(form.id)) return;
  event.preventDefault();
  if (form.id === "goal-form") return submitGoal(form);
  if (form.id === "timeline-form") return loadTimeline(form);
  const button = form.querySelector("button[type=submit], button:not([type])"); if (button) button.disabled = true;
  try {
    if (form.id === "mac-host-form") {
      const data = new FormData(form);
      await api("/api/options/mac-host", { method: "PUT", body: JSON.stringify({ enabled: data.get("enabled") === "on", target: data.get("target"), port: data.get("port"), root: data.get("root") }) });
      await refresh(true); notify("Mac Build Host settings saved."); return;
    }
    if (form.id === "mac-project-form") {
      const data = new FormData(form);
      await api("/api/options/mac-project", { method: "PUT", body: JSON.stringify({ setupCommand: data.get("setupCommand"), secrets: optionSecrets }) });
      notify("Remote project setup saved."); return;
    }
    if (form.id === "mac-secret-form") {
      const data = new FormData(form); const variable = data.get("variable").toString(); const name = data.get("name").toString();
      await api("/api/options/mac-secret", { method: "POST", body: JSON.stringify({ name, value: data.get("value") }) });
      optionSecrets[variable] = name;
      await api("/api/options/mac-project", { method: "PUT", body: JSON.stringify({ setupCommand: new FormData($("#mac-project-form")).get("setupCommand"), secrets: optionSecrets }) });
      form.reset(); renderSecretMappings(); notify("Secret saved to the Mac Keychain and mapped to this repository."); return;
    }
    if (form.id === "git-commit-form") {
      const data = new FormData(form);
      await api("/api/git/commit", { method: "POST", body: JSON.stringify({ head: form.dataset.head, message: data.get("message"), files: data.getAll("files") }) });
      await refreshGitView(); notify("Selected files saved in a local commit."); return;
    }
    if (form.id === "repo-form") { await switchRepository(new FormData(form).get("path")?.toString() || ""); return; }
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
  if (event.target.id === "status-persona-filter" || event.target.id === "status-event-filter" || event.target.id === "status-run-filter") {
    const key = event.target.id === "status-persona-filter" ? "persona" : event.target.id === "status-event-filter" ? "event" : "run";
    state.statusFilters[key] = event.target.value;
    if (key === "run" && !["selected", "all"].includes(event.target.value)) state.selectedRun = event.target.value;
    renderSidebar(); renderStatusBoard();
    return;
  }
  if (event.target.id !== "provider-select") return;
  const selected = event.target.value;
  const model = $("#model-input");
  model.value = "";
  $("#known-models").innerHTML = [...new Set(state.profiles.filter((person) => person.effective?.provider === selected).map((person) => person.effective.model).filter(Boolean))].map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
  model.placeholder = selected === "mock" ? "No model needed" : "Choose or enter a model ID";
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { $("#review-modal")?.remove(); $("#repo-modal")?.remove(); $("#git-modal")?.remove(); $("#options-modal")?.remove(); }
});

await refresh();
setInterval(() => { if (state.view === "workshop") void refresh(true); }, 4000);
