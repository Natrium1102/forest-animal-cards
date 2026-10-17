'use strict';
const G = require('./server/game');
let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('PASS',m)}else{fail++;console.log('FAIL',m)} };

function fresh2() { return G.createGame([{id:'A',name:'甲'},{id:'B',name:'乙'}]); }

/* 撤销：打出后收回手牌，返还 AP */
{
  const g = fresh2();
  G.command(g,'A',{action:'end_turn'});   // B 的回合
  const p = g.players.B; p.ap = 99;
  p.hand = [{cid:100,key:'squirrel'}];
  const r1 = G.command(g,'B',{action:'play',cid:100,row:'front',slot:0});
  ok(r1.ok, '打出松鼠成功');
  const inst = g.teams.b.board.front[0];
  ok(inst && inst.cid==='squirrel', '松鼠上场');
  const apAfter = p.ap;
  const r2 = G.command(g,'B',{action:'undo',iid:inst.iid});
  ok(r2.ok, '撤销指令成功');
  ok(g.teams.b.board.front[0]===null, '场上已无松鼠');
  ok(p.hand.some(c=>c.cid===100), '松鼠回到手牌');
  ok(p.ap > apAfter, `行动点已返还 (${apAfter}->${p.ap})`);
}

/* 换位：打出后移动到另一格 */
{
  const g = fresh2();
  G.command(g,'A',{action:'end_turn'});
  const p = g.players.B; p.ap = 99;
  p.hand = [{cid:100,key:'wolf'}];
  G.command(g,'B',{action:'play',cid:100,row:'front',slot:0});
  const inst = g.teams.b.board.front[0];
  const r = G.command(g,'B',{action:'move',iid:inst.iid,row:'back',slot:2});
  ok(r.ok, '换位指令成功');
  ok(g.teams.b.board.front[0]===null, '原位置已空');
  ok(g.teams.b.board.back[2] && g.teams.b.board.back[2].cid==='wolf', '狼移到后排第3格');
}

/* 撤销限制：非本回合打出的不可撤销 */
{
  const g = fresh2();
  const p=g.players.A; p.ap=99; p.hand=[{cid:100,key:'frog'}];
  G.command(g,'A',{action:'play',cid:100,row:'front',slot:0});
  const inst = g.teams.a.board.front[0];
  G.command(g,'A',{action:'end_turn'});   // 切到 B
  G.command(g,'B',{action:'end_turn'});   // 切回 A
  const r = G.command(g,'A',{action:'undo',iid:inst.iid});
  ok(!r.ok, '非本回合动物不可撤销 -> '+r.error);
}

/* 4 人 2v2：分队、共享战场与能量 */
{
  const g = G.createGame([
    {id:'A1',name:'A1',team:'a'},{id:'B1',name:'B1',team:'b'},
    {id:'A2',name:'A2',team:'a'},{id:'B2',name:'B2',team:'b'}
  ]);
  ok(g.order.length===4, '4 人回合序列');
  ok(g.teams.a.members.length===2 && g.teams.b.members.length===2, '每队 2 人');
  ok(g.teams.a.energy===20 && g.teams.b.energy===20, '每队 20 能量');
  // A1 出牌到 a 队战场
  const p=g.players.A1; p.ap=99; p.hand=[{cid:100,key:'squirrel'}];
  G.command(g,'A1',{action:'play',cid:100,row:'front',slot:0});
  ok(g.teams.a.board.front[0] && g.teams.a.board.front[0].cid==='squirrel', 'A1 出牌落到 a 队战场');
  // 轮到 A2 时也能用 a 队战场动物攻击
  G.command(g,'A1',{action:'end_turn'});  // B1
  G.command(g,'B1',{action:'end_turn'});  // A2
  ok(g.activeId==='A2', '回合轮转至 A2');
  const a2 = g.players.A2;
  ok(a2.team==='a', 'A2 属于 a 队');
}

/* 2v2 攻击：a 队动物打 b 队能量 */
{
  const g = G.createGame([
    {id:'A1',name:'A1',team:'a'},{id:'B1',name:'B1',team:'b'},
    {id:'A2',name:'A2',team:'a'},{id:'B2',name:'B2',team:'b'}
  ]);
  const p=g.players.A1; p.ap=99; p.hand=[{cid:100,key:'eagle'}];
  G.command(g,'A1',{action:'play',cid:100,row:'front',slot:0});
  const eagle = g.teams.a.board.front[0];
  const r = G.command(g,'A1',{action:'attack',iid:eagle.iid,target:'hero'});
  ok(r.ok, '2v2 老鹰直击 b 队英雄成功');
  ok(g.teams.b.energy < 20, 'b 队能量下降 -> '+g.teams.b.energy);
}

/* AI 自对 2v2：跑满不崩 */
{
  const AI = require('./server/ai');
  const g = G.createGame([
    {id:'A1',team:'a',isAI:true},{id:'B1',team:'b',isAI:true},
    {id:'A2',team:'a',isAI:true},{id:'B2',team:'b',isAI:true}
  ]);
  let guard=0;
  while(g.phase==='playing' && guard++<8000){
    const r = G.command(g, g.activeId, AI.decideNextAction(g, g.activeId));
    if(!r.ok) break;
  }
  ok(g.phase==='over', `2v2 AI 自对结束 (原因:${g.endReason})`);
}

console.log(`\n==== ${fail===0?'全部通过':'存在失败'}：PASS=${pass} FAIL=${fail} ====`);
process.exit(fail===0?0:1);
