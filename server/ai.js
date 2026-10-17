'use strict';

/* ============================================================
 * AI 对手 —— 与人类共用同一套服务端规则
 *
 * AI 是「虚拟玩家」，无真实 socket；服务器通过 pumpAI 定时调用
 * decideNextAction() 取一条指令交 game.command() 执行。
 * AI 只通过 snapshotFor() 脱敏快照感知局面，信息与人类一致。
 *
 * 策略（可解释启发式）：
 *  出牌：高攻优先 / 集色路线（第3色绝杀）/ 技能价值加权
 *  攻击：致命一击 > 低血压脸 > 击杀高价值目标 > 安全磨血
 *  无事可做 → 结束回合。
 * ============================================================ */

const gameLib = require('./game');

const AI_NAMES = ['灵狐小道', '憨憨棕熊', '夜行枭', '刺刺球'];
const BACK_ROW_KEYS = new Set(['fox', 'owl', 'squirrel', 'frog', 'eagle']);
const HIGH_VALUE = new Set(['deer', 'frog', 'bear', 'wolf']);

let aiSeq = 0;

function createAIPlayer(usedNames = []) {
  aiSeq += 1;
  const name =
    AI_NAMES.find((n) => !usedNames.includes(n)) ||
    `${AI_NAMES[aiSeq % AI_NAMES.length]}${aiSeq}`;
  return { id: `ai-${Date.now().toString(36)}-${aiSeq}`, name, isAI: true, online: true };
}

function flattenBoard(tv) {
  const out = [];
  for (const row of ['front', 'back']) {
    tv.board[row].forEach((a, slot) => { if (a) out.push(Object.assign({}, a, { row, slot })); });
  }
  return out;
}

function decideNextAction(game, aiId) {
  if (game.phase !== 'playing' || game.activeId !== aiId) return null;

  const snap = gameLib.snapshotFor(game, aiId);
  const me = snap.me;            // 己方队伍视图（含 board / energy / colors）
  const foe = snap.foe;          // 对方队伍视图
  const myAnimals = flattenBoard(me);
  const foeAnimals = flattenBoard(foe);
  const foeMap = new Map(foeAnimals.map((a) => [a.iid, a]));

  // 对方队伍总手牌数（夜视/狡诈判断用）
  const foeHandCount = snap.players
    .filter((p) => p.team !== snap.myTeam)
    .reduce((s, p) => s + p.handCount, 0);

  const myColors = new Set((me.colors || []).map((c) => c.key));
  const colorCount = myColors.size;

  /* ---------- 1) 出牌：打分选最强可打牌 ---------- */
  if (myAnimals.length < 6) {
    const playable = snap.yourHand.filter((c) => c.playable);
    let best = null;
    for (const c of playable) {
      let score = c.atk * 1.8 + c.baseCost * 1.0 + c.def * 0.9;

      const isNewColor = !myColors.has(c.territory);
      if (isNewColor) {
        if (colorCount >= 2) score += 1000;   // 第 3 色绝杀
        else score += 5;
      }

      if (c.key === 'bear' && foeAnimals.length > 0) score += 6;
      if (c.key === 'frog') score += 2.5;
      if (c.key === 'deer') score += 2;
      if ((c.key === 'owl' || c.key === 'fox') && foeHandCount > 0) score += 1.5;
      if (c.key === 'eagle' && foeAnimals.some((a) => a.row === 'back')) score += 1.5;
      if ((c.key === 'wolf' || c.key === 'squirrel') && foe.energy <= 8) score += 2;

      score += Math.random() * 0.8;
      if (!best || score > best.score) best = { card: c, score };
    }
    if (best) {
      const row = BACK_ROW_KEYS.has(best.card.key) ? 'back' : 'front';
      return { action: 'play', cid: best.card.cid, row };
    }
  }

  /* ---------- 2) 攻击 ---------- */
  let bestAttack = null;
  const suppress = foe.energy <= 8;
  for (const a of myAnimals) {
    if (a.attacksLeft <= 0 || !a.canAttack) continue;

    if (a.heroLegal && foe.energy <= a.atk) {
      return { action: 'attack', iid: a.iid, target: 'hero' };
    }

    const options = [];
    for (const tid of a.targets) {
      const t = foeMap.get(tid);
      if (!t) continue;
      const tHp = t.def - t.dmg;
      const myHp = a.def - a.dmg;
      const kill = tHp <= a.atk;
      const die = myHp <= t.atk;
      let gain;
      if (kill) {
        gain = 4 + t.atk * 1.4 + t.def * 0.5 + (HIGH_VALUE.has(t.cid) ? 2.5 : 0);
        if (!die) gain += 3;
      } else {
        if (die) continue;
        gain = 0.6 + tHp * 0.15 - a.atk * 0.05;
      }
      if (a.cid === 'eagle' && t.row === 'back' && HIGH_VALUE.has(t.cid)) gain += 2;
      options.push({ gain, tid });
    }
    if (a.heroLegal) {
      let heroGain = 2 + a.atk * 0.8;
      if (suppress) heroGain += 6 + a.atk * 0.6;
      options.push({ gain: heroGain, tid: 'hero' });
    }
    if (options.length) {
      options.sort((x, y) => y.gain - x.gain);
      const top = options[0];
      if (!bestAttack || top.gain > bestAttack.gain) {
        bestAttack = { gain: top.gain, cmd: { action: 'attack', iid: a.iid, target: top.tid } };
      }
    }
  }
  if (bestAttack) return bestAttack.cmd;

  return { action: 'end_turn' };
}

module.exports = { AI_NAMES, createAIPlayer, decideNextAction };
