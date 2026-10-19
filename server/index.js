'use strict';

/* ============================================================
 * 森林动物卡牌对战 —— Socket.IO 服务器
 *  - 房间管理（6 位房间码 / 2 或 4 人上限）
 *  - 消息转发、AI 行动泵、掉线玩家转 AI 托管
 *  - 胜负裁决在 game.js（唯一权威），AI 决策在 ai.js
 *
 * 客户端指令：{ action:'play'|'undo'|'move'|'attack'|'end_turn', ... }
 * ============================================================ */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const gameLib = require('./game');
const aiLib = require('./ai');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

/* ---------------- 房间表 ---------------- */
/**
 * room: { code, maxPlayers, isAIRoom, status:'waiting'|'playing'|'finished',
 *         hostId, channel, seats:[{id,name,isAI,online,socketId?,team?}],
 *         game, timers, events:[{text,kind}] }
 */
const rooms = new Map();

function generateCode() {
  let code;
  do { code = String(100000 + Math.floor(Math.random() * 900000)); } while (rooms.has(code));
  return code;
}

function createRoom(maxPlayers, isAIRoom, mode) {
  const code = generateCode();
  const m = gameLib.MODES[mode] ? mode : 'normal';
  const room = {
    code,
    maxPlayers,
    isAIRoom,
    mode: m,
    modeName: gameLib.MODES[m].name,
    status: 'waiting',
    hostId: null,
    channel: `room:${code}`,
    seats: [],
    game: null,
    timers: [],
    events: []
  };
  rooms.set(code, room);
  return room;
}

function clearTimers(room) { for (const t of room.timers) clearTimeout(t); room.timers = []; }
function destroyRoom(room) { clearTimers(room); rooms.delete(room.code); }
function humanSeats(room) { return room.seats.filter((s) => !s.isAI); }

function cleanName(raw) {
  const n = String(raw == null ? '' : raw).trim().slice(0, 10);
  return n || `游客${Math.floor(1000 + Math.random() * 9000)}`;
}

function addEvent(room, text, kind = 'info') {
  room.events.push({ text, kind, t: Date.now() });
  if (room.events.length > 40) room.events.shift();
}

/* ---------------- 广播 ---------------- */
function lobbyPayload(room) {
  return {
    code: room.code,
    maxPlayers: room.maxPlayers,
    status: room.status,
    hostId: room.hostId,
    isAIRoom: room.isAIRoom,
    mode: room.mode,
    modeName: room.modeName,
    players: room.seats.map((s) => ({
      id: s.id, name: s.name, isAI: s.isAI, online: s.online,
      team: s.team || null, isHost: s.id === room.hostId
    })),
    events: room.events.slice(-20)
  };
}
function emitLobby(room) { io.to(room.channel).emit('lobby_state', lobbyPayload(room)); }

function sendGameState(room, evtName = 'game_state') {
  if (!room.game) return;
  for (const seat of room.seats) {
    if (seat.isAI || !seat.socketId) continue;
    io.to(seat.socketId).emit(evtName, gameLib.snapshotFor(room.game, seat.id));
  }
}

/* ---------------- 开局与 AI 泵 ---------------- */
function startMatch(room) {
  clearTimers(room);

  // 分队：2 人各一队；4 人按座位奇偶（0,2→a；1,3→b）
  room.seats.forEach((s, i) => {
    s.team = room.maxPlayers === 4 ? (i % 2 === 0 ? 'a' : 'b') : (i === 0 ? 'a' : 'b');
  });

  const players = room.seats.map((s) => ({ id: s.id, name: s.name, isAI: s.isAI, team: s.team }));
  room.game = gameLib.createGame(players, { mode: room.mode });
  room.status = 'playing';
  addEvent(room, '对局开始', 'start');
  sendGameState(room, 'game_start');
  pumpAI(room);
}

function pumpAI(room, delay = 1100) {
  const g = room.game;
  if (!g || g.phase !== 'playing') return;
  const active = room.seats.find((s) => s.id === g.activeId);
  if (!active || !active.isAI) return;

  const timer = setTimeout(() => {
    if (!rooms.has(room.code) || room.game !== g || g.phase !== 'playing') return;
    const cmd = aiLib.decideNextAction(g, active.id);
    if (cmd) {
      const res = gameLib.command(g, active.id, cmd);
      if (!res.ok) {
        console.error(`[AI ${room.code}] 非法指令:`, res.error, JSON.stringify(cmd));
        gameLib.command(g, active.id, { action: 'end_turn' });
      }
      sendGameState(room);
    }
    if (g.phase === 'over') { room.status = 'finished'; return; }
    pumpAI(room, g.activeId === active.id ? 1000 : 1100);
  }, delay);
  room.timers.push(timer);
}

/* ---------------- 人类指令入口 ---------------- */
function handleHumanAction(socket, payload) {
  const room = rooms.get(socket.data.roomCode);
  if (!room || !room.game || room.game.phase !== 'playing') return;
  const res = gameLib.command(room.game, socket.data.playerId, payload);
  if (!res.ok) { socket.emit('error_msg', { message: res.error }); return; }
  sendGameState(room);
  if (room.game.phase === 'over') { room.status = 'finished'; return; }
  pumpAI(room);
}

/* ---------------- 入座 / 离座 ---------------- */
function joinSeat(socket, room, name) {
  const used = new Set(room.seats.map((s) => s.name));
  let finalName = name, suffix = 2;
  while (used.has(finalName)) finalName = `${name}${suffix++}`;

  const seat = {
    id: socket.id, name: finalName, isAI: false, online: true, socketId: socket.id, team: null
  };
  room.seats.push(seat);
  socket.join(room.channel);
  socket.data.roomCode = room.code;
  socket.data.playerId = socket.id;
  if (!room.hostId) room.hostId = socket.id;
  addEvent(room, `${finalName} 加入了房间`, 'join');
  return seat;
}

function leaveCurrent(socket, silent = false) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.data.playerId = null;
  if (!room) return;

  socket.leave(room.channel);
  const idx = room.seats.findIndex((s) => s.socketId === socket.id);
  if (idx >= 0) {
    const seat = room.seats[idx];
    room.seats.splice(idx, 1);
    if (!silent) addEvent(room, `${seat.name} 离开了房间`, 'leave');
  }

  const others = humanSeats(room);
  if (room.isAIRoom || others.length === 0) { destroyRoom(room); return; }

  if (room.status === 'playing') {
    // 对战中离开：房间不销毁，由 disconnect 路径已转 AI；这里若还有人则继续
    if (room.seats.length === 0) destroyRoom(room);
    return;
  }
  if (room.hostId === socket.id && others.length > 0) room.hostId = others[0].id;
  emitLobby(room);
}

/* ---------------- Socket 事件 ---------------- */
io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.playerId = null;

  socket.on('create_room', (payload = {}) => {
    leaveCurrent(socket, true);
    const maxPlayers = Number(payload.maxPlayers) === 4 ? 4 : 2;
    const room = createRoom(maxPlayers, false, payload.mode);
    joinSeat(socket, room, cleanName(payload.nickname));
    socket.emit('joined_room', { code: room.code, playerId: socket.id });
    emitLobby(room);
  });

  socket.on('join_room', (payload = {}) => {
    const code = String(payload.code == null ? '' : payload.code).replace(/\D/g, '');
    const room = rooms.get(code);
    if (!room) return socket.emit('error_msg', { message: '房间不存在，请核对 6 位房间码' });
    if (room.isAIRoom) return socket.emit('error_msg', { message: '该房间是 AI 对局，无法加入' });
    if (room.status !== 'waiting') return socket.emit('error_msg', { message: '游戏已经开始，等下一局吧' });
    if (humanSeats(room).length >= room.maxPlayers) return socket.emit('error_msg', { message: '房间已满员' });
    leaveCurrent(socket, true);
    joinSeat(socket, room, cleanName(payload.nickname));
    socket.emit('joined_room', { code: room.code, playerId: socket.id });
    emitLobby(room);
  });

  socket.on('start_ai', (payload = {}) => {
    leaveCurrent(socket, true);
    const room = createRoom(2, true, payload.mode);
    joinSeat(socket, room, cleanName(payload.nickname));
    const bot = aiLib.createAIPlayer(room.seats.map((s) => s.name));
    room.seats.push(bot);
    socket.emit('joined_room', { code: room.code, playerId: socket.id });
    startMatch(room);
  });

  socket.on('start_game', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'waiting') return;
    const humans = humanSeats(room);
    if (humans.length === 0) return;
    // 空位由 AI 补位（复用同一套 AI）
    const usedNames = room.seats.map((s) => s.name);
    while (room.seats.length < room.maxPlayers) {
      room.seats.push(aiLib.createAIPlayer(usedNames));
      usedNames.push(room.seats[room.seats.length - 1].name);
    }
    emitLobby(room);
    startMatch(room);
  });

  socket.on('game_action', (payload) => handleHumanAction(socket, payload));

  socket.on('back_to_lobby', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.game || room.game.phase !== 'over') return;
    clearTimers(room);
    room.game = null;
    room.status = 'waiting';
    // 移除所有 AI 座位（补位/托管），保留人类玩家以便下一局重新补位
    room.seats = room.seats.filter((s) => !s.isAI);
    if (room.seats.length === 0) { destroyRoom(room); return; }
    emitLobby(room);
  });

  socket.on('leave_room', () => leaveCurrent(socket, false));

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const seat = room.seats.find((s) => s.socketId === socket.id);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    socket.leave(room.channel);

    if (!seat) return;

    // 对战中掉线 → 转 AI 托管，不毁房
    if (room.status === 'playing' && room.game) {
      seat.isAI = true;
      seat.online = false;
      seat.socketId = null;
      addEvent(room, `${seat.name} 掉线，由电脑托管`, 'ai_takeover');
      // 通知其他人类玩家
      for (const s of room.seats) {
        if (s.socketId) io.to(s.socketId).emit('player_takenover', { id: seat.id, name: seat.name });
      }
      sendGameState(room);
      pumpAI(room);
      return;
    }

    // 等待中离开
    const idx = room.seats.indexOf(seat);
    if (idx >= 0) room.seats.splice(idx, 1);
    addEvent(room, `${seat.name} 离开了房间`, 'leave');
    const others = humanSeats(room);
    if (room.isAIRoom || others.length === 0) { destroyRoom(room); return; }
    if (room.hostId === seat.id) room.hostId = others[0].id;
    emitLobby(room);
  });
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && process.pkg) {
    // 端口被占用说明游戏已在运行，直接打开浏览器即可
    console.log('游戏已经在运行中，正在为你打开浏览器...');
    require('child_process').exec(`start http://localhost:${PORT}`);
    setTimeout(() => process.exit(0), 2000);
  } else {
    throw err;
  }
});

httpServer.listen(PORT, () => {
  console.log(`森林动物卡牌对战服务器已启动: http://localhost:${PORT}`);
  console.log(`端口读取自 process.env.PORT，当前为 ${PORT}`);
  // 打包为 exe 运行时，自动打开浏览器
  if (process.pkg) {
    require('child_process').exec(`start http://localhost:${PORT}`);
  }
});
