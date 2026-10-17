'use strict';

/* ============================================================
 * 森林动物卡牌对战 —— 服务端唯一权威对战引擎
 *
 * 客户端只能发 command：
 *   { action:'play',     cid, row:'front'|'back', slot?:0-2 }
 *   { action:'undo',     iid }            // 收回本回合刚打出的动物
 *   { action:'move',     iid, row, slot } // 调整本回合动物的位置
 *   { action:'attack',   iid, target:'hero' | 目标动物 iid }
 *   { action:'end_turn' }
 *
 * 队伍架构（兼容 2 人 1v1 与 4 人 2v2）：
 *  - energy / board / 领地色 属于「队伍」（2 人时每人即独立队伍）
 *  - hand / deck / intel / ap 属于「玩家」
 *  - 回合按 game.order 轮转；在自己的回合里用自己的手牌与行动点，
 *    出牌落到所属队伍的共享战场上。
 *
 * 核心规则：
 *  - 队伍 20 点森林能量，归零即败；己方战场集齐 3 种不同领地色也获胜。
 *  - 每回合开始：行动点 = min(己方回合数,10)，摸 2 张（手牌上限8）。
 *  - 行动点足够可连续出多张牌；本回合刚打出的动物可「收回手牌」或
 *    「拖拽换位」，下回合起锁定。
 *  - 战场每队前排3格+后排3格；新动物入场当回合即可攻击。
 *  - 普通攻击只能选对方前排；前排清空后可打后排或英雄；老鹰俯冲越前排。
 *  - 60 个行动回合（30 轮）打满按剩余能量裁决。
 * ============================================================ */

/* ---------------- 卡牌与领地定义 ---------------- */
const TERRITORIES = {
  forest: { key: 'forest', name: '林地', color: '#4f9e58' },
  field:  { key: 'field',  name: '原野', color: '#d9a441' },
  water:  { key: 'water',  name: '水域', color: '#38b2c4' },
  sky:    { key: 'sky',    name: '天空', color: '#9a6fe0' }
};

const CARDS = {
  wolf:     { key:'wolf',     name:'狼',     cost:4, atk:6, def:4, territory:'forest', bodyColor:'#9aa3ad', ability:'狼群突袭', abilityDesc:'本回合可额外攻击1次' },
  bear:     { key:'bear',     name:'熊',     cost:6, atk:8, def:5, territory:'forest', bodyColor:'#8d6b4d', ability:'蛮力',     abilityDesc:'入场时强行夺走对方场上1只动物' },
  owl:      { key:'owl',      name:'猫头鹰', cost:3, atk:4, def:3, territory:'sky',    bodyColor:'#5a90e0', ability:'夜视',     abilityDesc:'入场时偷看对方1张手牌' },
  fox:      { key:'fox',      name:'狐狸',   cost:2, atk:3, def:3, territory:'field',  bodyColor:'#e8873a', ability:'狡诈',     abilityDesc:'入场时与对方交换1张手牌' },
  squirrel: { key:'squirrel', name:'松鼠',   cost:1, atk:2, def:2, territory:'field',  bodyColor:'#e8c246', ability:'迅捷',     abilityDesc:'本回合可行动2次（攻击2次）' },
  deer:     { key:'deer',     name:'鹿',     cost:4, atk:5, def:4, territory:'forest', bodyColor:'#5fae5e', ability:'守护',     abilityDesc:'同排相邻动物防御+2' },
  frog:     { key:'frog',     name:'青蛙',   cost:2, atk:3, def:4, territory:'water',  bodyColor:'#3ec6b0', ability:'跳跃',     abilityDesc:'己方手牌出牌费用-1（可叠加）' },
  eagle:    { key:'eagle',    name:'老鹰',   cost:4, atk:6, def:3, territory:'sky',    bodyColor:'#a06fe0', ability:'俯冲',     abilityDesc:'可越过前排攻击后场任意动物' }
};
const CARD_KEYS = Object.keys(CARDS);

const MAX_ENERGY = 40;
const INITIAL_HAND = 6;
const DRAW_PER_TURN = 2;
const HAND_LIMIT = 8;
const ROW_SLOTS = 3;
const MAX_TURNS = 40;
const MULTI_ATTACK_KEYS = new Set(['wolf', 'squirrel']);
const BACK_ROW_PREFER = new Set(['fox', 'owl', 'squirrel', 'frog', 'eagle']);

/* ---------------- 工具 ---------------- */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function teamOf(game, playerId) {
  return game.players[playerId] ? game.players[playerId].team : null;
}
function myTeam(game, playerId) {
  return game.teams[teamOf(game, playerId)];
}
function foeTeam(game, playerId) {
  return game.teams[teamOf(game, playerId) === 'a' ? 'b' : 'a'];
}
function teammateIds(game, playerId) {
  return myTeam(game, playerId).members;
}

function boardAnimals(team) {
  const out = [];
  for (const row of ['front', 'back']) {
    team.board[row].forEach((a) => { if (a) out.push(a); });
  }
  return out;
}

function findAnimal(game, iid) {
  for (const tkey of ['a', 'b']) {
    const team = game.teams[tkey];
    for (const row of ['front', 'back']) {
      for (const a of team.board[row]) if (a && a.iid === iid) return { team, animal: a, row };
    }
  }
  return null;
}

function effectiveDef(game, animal) {
  const team = game.teams[animal.teamKey];
  let bonus = 0;
  for (const s of [animal.slot - 1, animal.slot + 1]) {
    const n = team.board[animal.row][s];
    if (n && n.cid === 'deer') bonus += 2;
  }
  return animal.baseDef + bonus;
}

/** 青蛙跳跃光环：己方队伍每只在场青蛙使出牌费用 -1 */
function frogCount(team) {
  return boardAnimals(team).filter((a) => a.cid === 'frog').length;
}
function cardCost(team, card) {
  return Math.max(0, card.cost - frogCount(team));
}

function frontRowHasAnimals(team) {
  return team.board.front.some(Boolean);
}

function territoryColors(team) {
  const set = new Set();
  for (const a of boardAnimals(team)) set.add(a.territory);
  return set;
}

/* ---------------- 建局 ---------------- */
function createDeck() {
  const deck = [];
  let cid = 1;
  for (const key of CARD_KEYS) {
    for (let copies = 0; copies < 3; copies++) deck.push({ cid: cid++, key });
  }
  return shuffle(deck);
}

/**
 * @param {Array<{id,name,isAI?,team?}>} players  2 或 4 人；4 人须带 team:'a'|'b'
 */
function createGame(players) {
  if (!Array.isArray(players) || (players.length !== 2 && players.length !== 4)) {
    throw new Error('仅支持 2 人或 4 人对战');
  }
  if (players.length === 4 && players.some((p) => !['a', 'b'].includes(p.team))) {
    throw new Error('4 人对战需为每位玩家指定队伍 a/b');
  }

  const table = {};
  const teams = {
    a: { key: 'a', energy: MAX_ENERGY, board: { front: Array(ROW_SLOTS).fill(null), back: Array(ROW_SLOTS).fill(null) }, members: [] },
    b: { key: 'b', energy: MAX_ENERGY, board: { front: Array(ROW_SLOTS).fill(null), back: Array(ROW_SLOTS).fill(null) }, members: [] }
  };

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const team = p.team || (i === 0 ? 'a' : 'b');   // 2 人时交替分队
    const deck = createDeck();
    table[p.id] = {
      id: p.id,
      name: p.name,
      isAI: !!p.isAI,
      team,
      ap: 0,
      deck,
      hand: deck.splice(0, INITIAL_HAND),
      intel: []
    };
    teams[team].members.push(p.id);
  }

  const order = players.map((p) => p.id);
  const game = {
    phase: 'playing',
    activeId: order[0],
    turnNumber: 1,
    order,
    teamOrder: ['a', 'b'],
    teams,
    players: table,
    winnerId: null,      // 玩家 id（2人）或队伍 key（4人）
    winnerTeam: null,
    endReason: null,
    log: [],
    _iidSeq: 1,
    _cidSeq: 100000,
    _logSeq: 1,
    _opening: true       // 开局首个回合：不再额外摸牌（初始 6 张已发好，双方一致）
  };

  beginTurn(game, order[0]);
  return game;
}

/* ---------------- 日志 ---------------- */
function addLog(game, text, kind = 'info') {
  game.log.push({ seq: game._logSeq++, turn: game.turnNumber, text, kind });
  if (game.log.length > 80) game.log.shift();
}
function addIntel(game, playerId, text, cardKey) {
  const p = game.players[playerId];
  if (!p) return;
  const entry = { turn: game.turnNumber, text };
  if (cardKey && CARDS[cardKey]) entry.cardKey = cardKey;
  p.intel.push(entry);
  if (p.intel.length > 20) p.intel.shift();
}

/* ---------------- 回合状态机 ---------------- */
function beginTurn(game, playerId) {
  const p = game.players[playerId];
  const taken = Math.ceil(game.turnNumber / 2);
  p.ap = Math.min(taken, 10);

  // 唤醒己方队伍动物：本回合可攻击次数复位
  for (const a of boardAnimals(myTeam(game, playerId))) {
    a.attacksLeft = MULTI_ATTACK_KEYS.has(a.cid) ? 2 : 1;
  }

  // 开局首回合跳过摸牌（双方初始手牌一致）；之后每回合正常摸牌
  if (game._opening) game._opening = false;
  else drawCards(game, p, DRAW_PER_TURN);
  addLog(game, `第 ${game.turnNumber} 回合 · ${p.name} 的行动回合（${p.ap} 行动点）`, 'turn');
}

function drawCards(game, player, n) {
  for (let i = 0; i < n; i++) {
    if (player.deck.length === 0) break;
    const card = player.deck.shift();
    if (player.hand.length >= HAND_LIMIT) {
      addLog(game, `${player.name} 手牌已满，摸到的 ${CARDS[card.key].name} 被弃掉`, 'discard');
    } else {
      player.hand.push(card);
    }
  }
}

/* ---------------- 胜负裁决 ---------------- */
function settle(game) {
  if (game.phase === 'over') return;
  const a = game.teams.a, b = game.teams.b;

  if (a.energy <= 0 || b.energy <= 0) {
    game.phase = 'over';
    game.endReason = 'energy';
    if (a.energy <= 0 && b.energy <= 0) { game.winnerTeam = null; game.winnerId = null; }
    else {
      game.winnerTeam = a.energy <= 0 ? 'b' : 'a';
      const winTeam = game.teams[game.winnerTeam];
      game.winnerId = winTeam.members[0];   // 快照展示用
    }
    return;
  }

  const winA = territoryColors(a).size >= 3;
  const winB = territoryColors(b).size >= 3;
  if (winA || winB) {
    game.phase = 'over';
    game.endReason = 'territory';
    game.winnerTeam = winA && winB ? null : winA ? 'a' : 'b';
    if (game.winnerTeam) game.winnerId = game.teams[game.winnerTeam].members[0];
    else game.winnerId = null;
  }
}

/* ---------------- 攻击目标校验 ---------------- */
function legalTargets(game, attackerId, attackerIid) {
  const found = findAnimal(game, attackerIid);
  const res = { animals: [], hero: false };
  if (!found || found.team.key !== teamOf(game, attackerId)) return res;
  const enemy = foeTeam(game, attackerId);
  const bypass = found.animal.cid === 'eagle';
  const frontClear = !frontRowHasAnimals(enemy);

  enemy.board.front.forEach((a) => { if (a) res.animals.push(a.iid); });
  if (bypass || frontClear) {
    enemy.board.back.forEach((a) => { if (a) res.animals.push(a.iid); });
    res.hero = true;
  }
  return res;
}

/* ---------------- 出牌 / 实例化 ---------------- */
function makeInstance(game, cardKey, teamKey, row, slot, handCid) {
  const c = CARDS[cardKey];
  const perTurn = MULTI_ATTACK_KEYS.has(cardKey) ? 2 : 1;
  return {
    iid: `u${game._iidSeq++}`,
    cid: c.key,
    teamKey,
    row,
    slot,
    atk: c.atk,
    territory: c.territory,
    baseDef: c.def,
    dmg: 0,
    perTurn,
    attacksLeft: perTurn,
    summonedTurn: game.turnNumber,
    handCid,            // 原始手牌 cid，撤销时还原
    undoable: true,     // 仅直接从手牌打出的可撤销（蛮力夺取的不可）
    locked: false       // 参与过攻击后锁定：不可收回、不可换位
  };
}

function firstFreeSlot(team, preferRow) {
  if (team.board[preferRow].some((v) => !v)) {
    return { row: preferRow, slot: team.board[preferRow].indexOf(null) };
  }
  const other = preferRow === 'front' ? 'back' : 'front';
  if (team.board[other].some((v) => !v)) {
    return { row: other, slot: team.board[other].indexOf(null) };
  }
  return null;
}

function cmdPlay(game, playerId, payload) {
  const p = game.players[playerId];
  const team = myTeam(game, playerId);
  const handIdx = p.hand.findIndex((c) => c.cid === Number(payload.cid));
  if (handIdx < 0) return { ok: false, error: '手牌中没有这张牌' };
  const cardEntry = p.hand[handIdx];
  const card = CARDS[cardEntry.key];

  const cost = cardCost(team, card);
  if (p.ap < cost) return { ok: false, error: '行动点不足' };

  const wantRow = payload.row === 'back' ? 'back' : 'front';
  let row = wantRow;
  let slot = Number.isInteger(payload.slot) ? payload.slot : null;

  if (slot !== null) {
    if (slot < 0 || slot >= ROW_SLOTS) return { ok: false, error: '位置非法' };
    if (team.board[row][slot]) return { ok: false, error: '该位置已有动物' };
  } else {
    const pos = firstFreeSlot(team, row);
    if (!pos) return { ok: false, error: '战场已满（6 格）' };
    row = pos.row; slot = pos.slot;
  }

  p.ap -= cost;
  p.hand.splice(handIdx, 1);
  const inst = makeInstance(game, card.key, team.key, row, slot, cardEntry.cid);
  inst.handIdx = handIdx;          // 记录打出前的手牌位置，撤销时插回原位
  team.board[row][slot] = inst;
  addLog(game, `${p.name} 在${row === 'front' ? '前排' : '后排'}打出 ${card.name}（消耗${cost}行动点）`, 'play');

  onPlayAbility(game, p, card.key);
  settle(game);
  return { ok: true };
}

/* ---------------- 撤销出牌 ---------------- */
function cmdUndo(game, playerId, payload) {
  const team = myTeam(game, playerId);
  const found = findAnimal(game, String(payload.iid));
  if (!found || found.team.key !== team.key) return { ok: false, error: '这不是你的动物' };
  const a = found.animal;
  if (a.summonedTurn !== game.turnNumber) return { ok: false, error: '只能收回本回合刚打出的动物' };
  if (a.locked) return { ok: false, error: '它已参与攻击，被锁定在战场上' };
  if (!a.undoable) return { ok: false, error: '这只动物无法收回' };

  const p = game.players[playerId];
  if (p.hand.length >= HAND_LIMIT) return { ok: false, error: '手牌已满，无法收回' };

  const card = CARDS[a.cid];
  const cost = cardCost(team, card);
  team.board[a.row][a.slot] = null;
  p.ap = Math.min(10, p.ap + cost);   // 退还行动点
  // 插回打出前的原位置，保证玩家能在手牌原处看到收回的牌
  const backIdx = Math.min(a.handIdx != null ? a.handIdx : p.hand.length, p.hand.length);
  p.hand.splice(backIdx, 0, { cid: a.handCid, key: a.cid });
  addLog(game, `${p.name} 收回了刚打出的 ${card.name}，返还 ${cost} 行动点`, 'undo');
  settle(game);
  return { ok: true };
}

/* ---------------- 调整位置 ---------------- */
function cmdMove(game, playerId, payload) {
  const team = myTeam(game, playerId);
  const found = findAnimal(game, String(payload.iid));
  if (!found || found.team.key !== team.key) return { ok: false, error: '这不是你的动物' };
  const a = found.animal;
  if (a.summonedTurn !== game.turnNumber) return { ok: false, error: '只能移动本回合刚打出的动物' };
  if (a.locked) return { ok: false, error: '它已参与攻击，被锁定在战场上' };

  const row = payload.row === 'back' ? 'back' : 'front';
  const slot = Number(payload.slot);
  if (slot < 0 || slot >= ROW_SLOTS) return { ok: false, error: '位置非法' };
  if (a.row === row && a.slot === slot) return { ok: true };
  if (team.board[row][slot]) return { ok: false, error: '目标位置已有动物' };

  team.board[a.row][a.slot] = null;
  a.row = row; a.slot = slot;
  team.board[row][slot] = a;
  addLog(game, `${game.players[playerId].name} 将 ${CARDS[a.cid].name} 移至${row === 'front' ? '前排' : '后排'}第${slot + 1}格`, 'move');
  settle(game);
  return { ok: true };
}

function onPlayAbility(game, p, key) {
  const team = myTeam(game, p.id);
  const enemy = foeTeam(game, p.id);

  if (key === 'bear') {
    const targets = boardAnimals(enemy);
    if (targets.length === 0) { addLog(game, '蛮力发动，但对方场上没有动物可夺', 'ability'); return; }
    const victim = targets[Math.floor(Math.random() * targets.length)];
    enemy.board[victim.row][victim.slot] = null;
    const pos = firstFreeSlot(team, victim.row);
    victim.teamKey = team.key;
    victim.ownerId = p.id;
    victim.dmg = 0;
    victim.attacksLeft = MULTI_ATTACK_KEYS.has(victim.cid) ? 2 : 1;
    victim.summonedTurn = game.turnNumber;
    victim.undoable = false;        // 蛮力夺取的不可撤销
    if (pos) {
      victim.row = pos.row; victim.slot = pos.slot;
      team.board[pos.row][pos.slot] = victim;
      addLog(game, `蛮力！${p.name} 夺走了对方的 ${CARDS[victim.cid].name}`, 'ability');
    } else {
      if (p.hand.length < HAND_LIMIT) {
        p.hand.push({ cid: game._cidSeq++, key: victim.cid });
        addLog(game, `蛮力！${CARDS[victim.cid].name} 被夺取但战场已满，转为手牌`, 'ability');
      } else {
        addLog(game, `蛮力！${CARDS[victim.cid].name} 被夺取但双方已满，遗憾离场`, 'ability');
      }
    }
    return;
  }

  if (key === 'owl') {
    if (enemy.members.length === 0) return;
    // 从对方队伍所有玩家手牌中随机抽一张
    const allHands = enemy.members.map((id) => game.players[id]);
    const withCards = allHands.filter((pl) => pl.hand.length > 0);
    if (withCards.length === 0) { addLog(game, '夜视发动，但对方没有手牌', 'ability'); return; }
    const pl = withCards[Math.floor(Math.random() * withCards.length)];
    const seen = pl.hand[Math.floor(Math.random() * pl.hand.length)];
    const c = CARDS[seen.key];
    addLog(game, `夜视！${p.name} 偷看了对方 1 张手牌`, 'ability');
    addIntel(game, p.id, `夜视：你偷看到 ${pl.name} 手牌中的 ${c.name}`, seen.key);
    return;
  }

  if (key === 'fox') {
    const foePlayers = enemy.members.map((id) => game.players[id]).filter((pl) => pl.hand.length > 0);
    if (foePlayers.length === 0 || p.hand.length === 0) {
      addLog(game, '狡诈发动，但手牌交换条件不足', 'ability');
      return;
    }
    const mine = p.hand.splice(Math.floor(Math.random() * p.hand.length), 1)[0];
    const fp = foePlayers[Math.floor(Math.random() * foePlayers.length)];
    const theirs = fp.hand.splice(Math.floor(Math.random() * fp.hand.length), 1)[0];
    p.hand.push(theirs);
    fp.hand.push(mine);
    addLog(game, `狡诈！${p.name} 与 ${fp.name} 随机交换了 1 张手牌`, 'ability');
    addIntel(game, p.id, `狡诈：你用 ${CARDS[mine.key].name} 换来 ${CARDS[theirs.key].name}`, theirs.key);
    addIntel(game, fp.id, `对方的狐狸使你失去 ${CARDS[theirs.key].name}，换来 ${CARDS[mine.key].name}`, mine.key);
  }
}

/* ---------------- 攻击 ---------------- */
function cmdAttack(game, playerId, payload) {
  const team = myTeam(game, playerId);
  const found = findAnimal(game, String(payload.iid));
  if (!found || found.team.key !== team.key) return { ok: false, error: '没有这只动物' };
  const attacker = found.animal;
  if (attacker.attacksLeft <= 0) return { ok: false, error: '它本回合已经无法行动' };

  const legal = legalTargets(game, playerId, attacker.iid);
  const enemy = foeTeam(game, playerId);

  if (payload.target === 'hero') {
    if (!legal.hero) return { ok: false, error: '对方前排还有动物，无法直接攻击英雄（老鹰可俯冲）' };
    enemy.energy = Math.max(0, enemy.energy - attacker.atk);
    attacker.attacksLeft--;
    attacker.locked = true; attacker.undoable = false;   // 攻击后锁定在战场
    addLog(game, `${CARDS[attacker.cid].name} 直击对方英雄，造成 ${attacker.atk} 点能量伤害`, 'attack');
    settle(game);
    return { ok: true };
  }

  const targetIid = String(payload.target);
  if (!legal.animals.includes(targetIid)) return { ok: false, error: '这个目标现在不能被攻击' };
  const tFound = findAnimal(game, targetIid);
  const target = tFound.animal;

  const atkDmg = attacker.atk;
  const counterDmg = target.atk;
  target.dmg += atkDmg;
  attacker.dmg += counterDmg;
  attacker.attacksLeft--;
  attacker.locked = true; attacker.undoable = false;   // 攻击后锁定在战场

  const killTarget = target.dmg >= effectiveDef(game, target);
  const killSelf = attacker.dmg >= effectiveDef(game, attacker);
  addLog(game,
    `${CARDS[attacker.cid].name} 攻击 ${CARDS[target.cid].name}` +
    `（${atkDmg} 伤害${attacker.cid === 'eagle' ? '·俯冲' : ''}，受反击 ${counterDmg}）` +
    `${killTarget ? '，对手动物被击倒！' : ''}${killSelf ? '，己方动物也倒下了！' : ''}`,
    'attack');

  cleanupDead(game);
  settle(game);
  return { ok: true };
}

function cleanupDead(game) {
  for (const tkey of ['a', 'b']) {
    const team = game.teams[tkey];
    for (const row of ['front', 'back']) {
      for (let s = 0; s < ROW_SLOTS; s++) {
        const a = team.board[row][s];
        if (a && a.dmg >= effectiveDef(game, a)) {
          addLog(game, `${CARDS[a.cid].name} 离开了战场`, 'death');
          team.board[row][s] = null;
        }
      }
    }
  }
}

/* ---------------- 结束回合 ---------------- */
function cmdEndTurn(game, playerId) {
  if (game.activeId !== playerId) return { ok: false, error: '还没轮到你' };
  game.turnNumber++;

  if (game.turnNumber > MAX_TURNS) {
    const a = game.teams.a, b = game.teams.b;
    game.phase = 'over';
    game.endReason = 'turn';
    if (a.energy === b.energy) { game.winnerTeam = null; game.winnerId = null; }
    else { game.winnerTeam = a.energy > b.energy ? 'a' : 'b'; game.winnerId = game.teams[game.winnerTeam].members[0]; }
    addLog(game, '30 个回合已满，按剩余森林能量裁决', 'turn');
    return { ok: true };
  }

  const idx = game.order.indexOf(playerId);
  game.activeId = game.order[(idx + 1) % game.order.length];
  beginTurn(game, game.activeId);
  settle(game);
  return { ok: true };
}

/* ---------------- 唯一指令入口 ---------------- */
function command(game, playerId, payload = {}) {
  if (game.phase === 'over') return { ok: false, error: '对局已结束' };
  if (game.activeId !== playerId) return { ok: false, error: '还没轮到你行动' };
  switch (payload.action) {
    case 'play':     return cmdPlay(game, playerId, payload);
    case 'undo':     return cmdUndo(game, playerId, payload);
    case 'move':     return cmdMove(game, playerId, payload);
    case 'attack':   return cmdAttack(game, playerId, payload);
    case 'end_turn': return cmdEndTurn(game, playerId);
    default:         return { ok: false, error: '未知操作' };
  }
}

/* ---------------- 快照 ---------------- */
function animalView(game, a, viewerId) {
  const isMyTeam = a.teamKey === teamOf(game, viewerId);
  const legal = isMyTeam && game.activeId === viewerId && a.attacksLeft > 0
    ? legalTargets(game, viewerId, a.iid)
    : { animals: [], hero: false };
  const card = CARDS[a.cid];
  return {
    iid: a.iid,
    cid: a.cid,
    row: a.row,
    slot: a.slot,
    name: card.name,
    bodyColor: card.bodyColor,
    territory: a.territory,
    territoryName: TERRITORIES[a.territory].name,
    territoryColor: TERRITORIES[a.territory].color,
    ability: card.ability,
    atk: a.atk,
    def: effectiveDef(game, a),
    baseDef: a.baseDef,
    dmg: a.dmg,
    attacksLeft: a.attacksLeft,
    perTurn: a.perTurn,
    canAttack: legal.animals.length > 0 || legal.hero,
    canUndo: isMyTeam && a.summonedTurn === game.turnNumber && a.undoable && !a.locked,
    canMove: isMyTeam && a.summonedTurn === game.turnNumber && !a.locked,
    locked: !!a.locked,
    targets: legal.animals,
    heroLegal: legal.hero
  };
}

function teamView(game, team, viewerId) {
  return {
    key: team.key,
    energy: team.energy,
    colors: [...territoryColors(team)].map((k) => ({ key: k, name: TERRITORIES[k].name, color: TERRITORIES[k].color })),
    board: {
      front: team.board.front.map((a) => (a ? animalView(game, a, viewerId) : null)),
      back: team.board.back.map((a) => (a ? animalView(game, a, viewerId) : null))
    }
  };
}

function snapshotFor(game, viewerId) {
  const viewer = game.players[viewerId];
  const myT = viewer ? game.teams[viewer.team] : null;
  const foeTKey = viewer && viewer.team === 'a' ? 'b' : 'a';
  const foeT = game.teams[foeTKey];
  const foePlayers = foeT.members.map((id) => game.players[id]);
  const myPlayers = myT ? myT.members.map((id) => game.players[id]) : [];

  return {
    phase: game.phase,
    activeId: game.activeId,
    turnNumber: game.turnNumber,
    maxTurns: MAX_TURNS,
    maxEnergy: MAX_ENERGY,
    handLimit: HAND_LIMIT,
    order: game.order.slice(),
    teamSize: myT ? myT.members.length : 1,
    myTeam: viewer ? viewer.team : 'a',
    me: myT ? teamView(game, myT, viewerId) : null,
    foe: teamView(game, foeT, viewerId),
    players: game.order.map((id) => {
      const pl = game.players[id];
      return {
        id: pl.id,
        name: pl.name,
        isAI: pl.isAI,
        team: pl.team,
        ap: pl.ap,
        handCount: pl.hand.length,
        deckCount: pl.deck.length,
        isActive: id === game.activeId
      };
    }),
    winnerId: game.winnerId,
    winnerTeam: game.winnerTeam,
    endReason: game.endReason,
    yourHand: viewer
      ? viewer.hand.map((entry) => {
          const c = CARDS[entry.key];
          return {
            cid: entry.cid,
            key: c.key,
            name: c.name,
            cost: cardCost(myT, c),
            baseCost: c.cost,
            atk: c.atk,
            def: c.def,
            bodyColor: c.bodyColor,
            territory: c.territory,
            territoryName: TERRITORIES[c.territory].name,
            territoryColor: TERRITORIES[c.territory].color,
            ability: c.ability,
            abilityDesc: c.abilityDesc,
            playable: game.activeId === viewerId && game.phase === 'playing' && viewer.ap >= cardCost(myT, c)
          };
        })
      : [],
    yourIntel: viewer ? viewer.intel.slice(-10) : [],
    log: game.log.slice(-50)
  };
}

module.exports = {
  CARDS, TERRITORIES, CARD_KEYS,
  MAX_ENERGY, HAND_LIMIT, ROW_SLOTS, MAX_TURNS,
  createGame, command, legalTargets, effectiveDef,
  boardAnimals, territoryColors, snapshotFor
};
