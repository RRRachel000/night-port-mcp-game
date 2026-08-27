const $ = (selector) => document.querySelector(selector);
const gameSelect = $("#game-select");
const refreshButton = $("#refresh-button");
const connectionStatus = $("#connection-status");
const dashboard = $("#dashboard");
const logPanel = $("#log-panel");
const emptyState = $("#empty-state");

let selectedGameId = new URLSearchParams(location.search).get("game");
let renderedVersion = null;
let refreshTimer = null;

const commodityCategory = {
  seafood: "cold_chain",
  flowers: "cold_chain",
  tropical_fruit: "cold_chain",
  tea: "ambient",
  spices: "ambient",
  timber: "ambient"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function phaseLabel(phase) {
  return ({
    lobby: "等待入席",
    achievement_selection: "秘密选择",
    active: "港区营业",
    carryover_vote: "结转表决",
    finished: "本航次结束"
  })[phase] ?? phase;
}

function playerName(state, playerId) {
  return state.players.find((player) => player.id === playerId)?.name ?? playerId ?? "—";
}

function setConnection(kind, text) {
  connectionStatus.className = `connection-status ${kind}`;
  connectionStatus.textContent = text;
}

async function loadGames() {
  const response = await fetch("/api/games", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取房间列表");
  const body = await response.json();
  const games = body.games ?? [];
  gameSelect.replaceChildren();
  for (const game of games) {
    const option = document.createElement("option");
    option.value = game.gameId;
    option.textContent = `${game.gameId} · ${phaseLabel(game.phase)}`;
    gameSelect.append(option);
  }
  if (games.length === 0) {
    selectedGameId = null;
    showEmpty();
    return false;
  }
  if (!games.some((game) => game.gameId === selectedGameId)) selectedGameId = games[0].gameId;
  gameSelect.value = selectedGameId;
  return true;
}

async function loadState(force = false) {
  try {
    setConnection("", "同步中");
    if (!selectedGameId) {
      if (!await loadGames()) return;
    }
    const response = await fetch(`/api/games/${encodeURIComponent(selectedGameId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("房间状态不可用");
    const state = await response.json();
    if (force || state.stateVersion !== renderedVersion) {
      render(state);
      renderedVersion = state.stateVersion;
    }
    setConnection("online", "已同步");
  } catch (error) {
    setConnection("error", "连接中断");
    console.error(error);
  }
}

function showEmpty() {
  emptyState.hidden = false;
  dashboard.hidden = true;
  logPanel.hidden = true;
  setConnection("", "等待开港");
}

function render(state) {
  emptyState.hidden = true;
  dashboard.hidden = false;
  logPanel.hidden = false;
  $("#game-title").textContent = state.gameName;
  $("#round-value").textContent = state.round ? `${state.round} / 3` : "—";
  $("#phase-value").textContent = phaseLabel(state.phase);
  $("#cold-chain-price").textContent = state.prices.cold_chain;
  $("#ambient-price").textContent = state.prices.ambient;
  $("#current-player").textContent = playerName(state, state.currentPlayer);
  $("#version-value").textContent = `状态版本 ${state.stateVersion}`;
  renderEvents(state.events);
  renderOrders(state.orders);
  renderMarket(state.market);
  renderPassChain(state);
  renderPlayers(state);
  renderLog(state.recentLog);
  document.title = `${state.gameName} · ${phaseLabel(state.phase)}`;
}

function renderEvents(events) {
  $("#events").innerHTML = events.length
    ? events.map((event) => `<div class="event-chip"><strong>${escapeHtml(event.name)}</strong><span>${escapeHtml(event.description)}</span></div>`).join("")
    : `<div class="event-chip"><strong>等待事件</strong><span>开局后揭晓本轮价格变化</span></div>`;
}

function renderOrders(orders) {
  $("#order-count").textContent = `${orders.filter((order) => !order.completed).length}/${orders.length}`;
  $("#orders-list").innerHTML = orders.map((order) => {
    const requirements = order.requirements.map((item) =>
      `<span class="cargo-chip" data-category="${escapeHtml(commodityCategory[item.commodityId])}">${escapeHtml(item.name)}</span>`
    ).join("");
    const meta = [
      order.carriedOver ? `<span class="text-badge carried">跨轮遗留</span>` : "",
      order.completed ? `<span class="text-badge">已由 ${escapeHtml(order.completedBy)} 核销</span>` : "",
      Number.isFinite(order.theoreticalNetProfit) ? `<span class="text-badge">理论净利 ${escapeHtml(order.theoreticalNetProfit)}</span>` : ""
    ].filter(Boolean).join("");
    return `<article class="order-card ${order.completed ? "completed" : ""}">
      <div class="order-card-header"><span class="order-number">航运委托 #${escapeHtml(order.id)}</span><span class="reward">${escapeHtml(order.reward)}</span></div>
      <div class="requirements">${requirements}</div>
      <div class="order-meta">${meta}</div>
    </article>`;
  }).join("");
}

function renderMarket(market) {
  $("#market-grid").innerHTML = market.map((slot) => {
    if (!slot.occupied) {
      return `<article class="market-slot empty" aria-label="货位 ${slot.position}，空位"><span class="slot-number">#${slot.position}</span><span>空位</span></article>`;
    }
    return `<article class="market-slot ${slot.inspectionCargo ? "inspection-cargo" : ""}" data-category="${escapeHtml(slot.category)}" aria-label="货位 ${slot.position}，${escapeHtml(slot.commodityName)}，${slot.currentPrice}币${slot.inspectionCargo ? "，海关查验货" : ""}">
      <span class="slot-number">SLOT #${slot.position}</span>
      <strong class="slot-cargo">${escapeHtml(slot.commodityName)}</strong>
      <span class="slot-footer"><span class="slot-price">${slot.currentPrice}</span>${slot.inspectionCargo ? '<span class="inspection-label">海关查验</span>' : ""}</span>
    </article>`;
  }).join("");
}

function renderPassChain(state) {
  const chain = state.passChain.map((id) => playerName(state, id));
  const remaining = state.endgameActionsRemaining
    ? Object.entries(state.endgameActionsRemaining).map(([id, value]) => `${playerName(state, id)} ${value}`).join(" · ")
    : null;
  $("#pass-chain").innerHTML = chain.length
    ? `<strong>停手链：</strong>${chain.map(escapeHtml).join(" → ")}${remaining ? `<br><strong>终局行动：</strong>${escapeHtml(remaining)}` : ""}`
    : `<strong>停手链：</strong>暂无连续 Pass${remaining ? `<br><strong>终局行动：</strong>${escapeHtml(remaining)}` : ""}`;
}

function renderPlayers(state) {
  $("#players-list").innerHTML = state.players.map((player) => {
    const inventory = Object.entries(player.inventoryCounts).map(([commodityId, count]) => {
      const first = player.inventory.find((item) => item.commodityId === commodityId);
      return `<span class="cargo-chip" data-category="${escapeHtml(commodityCategory[commodityId])}">${escapeHtml(first?.commodityName ?? commodityId)} ×${count}</span>`;
    }).join("");
    const specials = [
      player.hasNextRoundPriority ? "持有下一轮首购权" : "",
      player.hasEmergencyCoupon && !player.emergencyCouponUsed ? "持有紧急核销券" : ""
    ].filter(Boolean).join(" · ");
    return `<article class="player-card ${state.currentPlayer === player.id ? "current" : ""}">
      <div class="player-card-header"><div><h3>${escapeHtml(player.name)}</h3><span class="player-type">${escapeHtml(player.controllerType)}</span></div><span class="cash">${player.cash}</span></div>
      ${inventory ? `<div class="inventory-chips">${inventory}</div>` : '<p class="inventory-empty">仓库为空</p>'}
      <div class="player-ledger"><span>库存 ${player.inventory.length}</span><span>已完成 ${player.completedOrderIds.length}</span>${player.roundActionsRemaining == null ? "" : `<span>余 ${player.roundActionsRemaining} 动</span>`}</div>
      ${specials ? `<span class="priority-note">${escapeHtml(specials)}</span>` : ""}
    </article>`;
  }).join("");
}

function renderLog(entries) {
  $("#log-list").innerHTML = [...entries].reverse().map((entry) =>
    `<li value="${entry.sequence}"><strong>R${entry.round}</strong> · ${escapeHtml(entry.message)}</li>`
  ).join("");
}

gameSelect.addEventListener("change", () => {
  selectedGameId = gameSelect.value;
  renderedVersion = null;
  const url = new URL(location.href);
  url.searchParams.set("game", selectedGameId);
  history.replaceState(null, "", url);
  void loadState(true);
});

refreshButton.addEventListener("click", async () => {
  await loadGames();
  await loadState(true);
});

async function boot() {
  try {
    await loadGames();
    await loadState(true);
  } catch (error) {
    showEmpty();
    console.error(error);
  }
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => void loadState(), 2000);
}

void boot();
