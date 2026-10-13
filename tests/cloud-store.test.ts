import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqlGameStore, type SqlAdapter } from '../cloud/sql-store.js';
import { WindowCoordinator } from '../src/window-coordinator.js';

function fixture() {
  const db=new DatabaseSync(':memory:');
  let fail=false;
  const sql:SqlAdapter={exec(query,...args){
    if(fail && query.startsWith('UPDATE games'))throw new Error('fixture persistence failure');
    const statement=db.prepare(query); const rows=statement.columns().length?statement.all(...args):(statement.run(...args),[]);
    return {toArray:()=>rows};
  }};
  const store=new SqlGameStore(sql);
  const created=store.create({gameId:'cloud-test',creatorId:'a',creatorName:'A',creatorType:'ai',seed:1});
  for(const id of ['b','c'])store.transaction('cloud-test',g=>g.joinPlayer({playerId:id,playerName:id,controllerType:'ai',expectedStateVersion:g.stateVersion}));
  const coordinator=new WindowCoordinator(store,{cloud:true});
  const keys=Object.fromEntries(['a','b','c'].map(playerId=>[playerId,coordinator.bind('cloud-test',{playerId,threadId:playerId,hostId:'client',kind:'chatgpt'}).key]));
  return {db,sql,store,coordinator,keys,created,fail:()=>{fail=true;}};
}
test('cloud snapshot preserves seats and replay receipts across a storage instance restart',()=>{
  const f=fixture();try{
    const before=f.coordinator.myState(f.keys.a!) as any;
    const original=f.coordinator.submit(f.keys.a!,before.task.actionId,before.task.expectedStateVersion,{type:'start'});
    const restarted=new WindowCoordinator(new SqlGameStore(f.sql),{cloud:true});
    const replay=restarted.submit(f.keys.a!,before.task.actionId,before.task.expectedStateVersion,{type:'start'});
    assert.equal(replay.replayed,true);
    assert.equal(f.store.get('cloud-test').stateVersion,before.task.expectedStateVersion+1);
    assert.deepEqual({...replay,replayed:undefined},{...original,replayed:undefined});
    assert.equal((restarted.myState(f.keys.b!) as any).playerId,'b');
  }finally{f.db.close();}
});
test('cloud failed persistence and stale versions do not mutate stored games or jobs',()=>{
  const f=fixture();try{
    const state=f.coordinator.myState(f.keys.a!) as any;
    const before=f.store.exportSnapshot('cloud-test');
    assert.throws(()=>f.coordinator.submit(f.keys.a!,state.task.actionId,state.task.expectedStateVersion-1,{type:'start'}),/Read my_state/);
    assert.deepEqual(f.store.exportSnapshot('cloud-test'),before);
    f.fail();assert.throws(()=>f.coordinator.submit(f.keys.a!,state.task.actionId,state.task.expectedStateVersion,{type:'start'}),/persistence/);
    assert.deepEqual(f.store.exportSnapshot('cloud-test'),before);
  }finally{f.db.close();}
});
test('cloud import is idempotent, preserves private state, and rejects conflicting overwrite',()=>{
  const f=fixture();try{
    const snap=f.store.exportSnapshot('cloud-test');
    assert.equal(f.store.importSnapshot(snap).imported,false);
    assert.throws(()=>f.store.importSnapshot({...snap,stateVersion:snap.stateVersion+1}),/never overwrites/);
    assert.deepEqual(f.store.exportSnapshot('cloud-test'),snap);
    const restored={...snap,id:'restored'};assert.equal(f.store.importSnapshot(restored).imported,true);
    assert.deepEqual(f.store.exportSnapshot('restored'),restored);
    const publicText=JSON.stringify(f.store.get('restored').publicState());
    for(const p of restored.players)assert.equal(publicText.includes(p.token),false);
  }finally{f.db.close();}
});
