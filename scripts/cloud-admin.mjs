import fs from 'node:fs/promises';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const root=path.resolve(import.meta.dirname,'..');
const directory=path.join(root,'.local/cloud');
const config=JSON.parse(await fs.readFile(path.join(directory,'connection.json'),'utf8'));
const credentials=JSON.parse(await fs.readFile(path.join(directory,'credentials.json'),'utf8'));
const origin=new URL(config.origin);
if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/')throw new Error('Expected a private HTTPS service origin.');
const [operation,...args]=process.argv.slice(2);
const flags=new Map();for(let i=0;i<args.length;i+=2)flags.set(args[i],args[i+1]);
const auth={authorization:'Bearer '+credentials.operator,'content-type':'application/json'};
async function request(route,body){const response=await fetch(new URL(route,origin),{method:body?'POST':'GET',headers:auth,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Cloud request failed: '+response.status);return response.json();}
async function savePrivate(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});}
async function main(){
  if(operation==='export'){
    const target=path.resolve(flags.get('--out')||path.join(directory,`backup-${Date.now()}.json`));
    if(await fs.access(target).then(()=>true,()=>false))throw new Error('Export target already exists.');
    const result=await request('/api/admin/export');await savePrivate(target,result);console.log(JSON.stringify({ok:true,games:result.games.length,backupFile:target}));return;
  }
  if(operation==='import'){
    const file=flags.get('--file');if(!file)throw new Error('--file is required');
    const body=JSON.parse(await fs.readFile(file,'utf8'));const result=await request('/api/admin/import',body);console.log(JSON.stringify(result));return;
  }
  if(operation==='new-match'){
    const gameId=flags.get('--game');if(!/^[A-Za-z0-9_-]{1,100}$/.test(gameId||''))throw new Error('--game must be a safe unique ID');
    const target=path.join(directory,'matches',gameId+'.json');
    const existing=await fs.readFile(target,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
    if(existing?.setup==='ready')throw new Error('Local match connection file already exists.');
    const client=new Client({name:'night-port-private-operator',version:'0.3.0'});
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/lobby',origin),{requestInit:{headers:auth}}));
    try{
      const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw new Error('Game setup was not completed; inspect the existing game before retrying.');return r.structuredContent;};
      if(!existing)await call('create_game',{gameId,creatorId:'a',creatorName:flags.get('--a')||'AI A',controllerType:'ai'});
      const seats=existing?.seats||[];
      // Persist each provisioned capability immediately; an interrupted setup can be recovered.
      if(!existing)await savePrivate(target,{gameId,seats,setup:'creating'});
      for(const id of ['a','b','c']){
        if(seats.some(s=>s.playerId===id))continue;
        const state=await call('game_state',{gameId});
        if(!state.players.some(p=>p.id===id))await call('join_game',{gameId,playerId:id,playerName:flags.get('--'+id)||'AI '+id.toUpperCase(),controllerType:'ai',expectedStateVersion:state.stateVersion});
        const bind=await request('/api/referee',{operation:'bind',gameId,route:{playerId:id,threadId:`configure-client-${id}`,hostId:'remote',kind:'chatgpt'}});
        seats.push({gameId,playerId:id,generation:bind.result.generation,mcpUrl:new URL('/mcp/seat',origin).href,bearerToken:bind.result.key});
        await fs.writeFile(target,JSON.stringify({gameId,seats,setup:id==='c'?'ready':'creating'},null,2)+'\n',{mode:0o600});
      }
      for(const seat of seats) {
        const seatFile=path.join(directory,'seats',gameId,seat.playerId+'.json');
        if(!await fs.access(seatFile).then(()=>true,()=>false))await savePrivate(seatFile,seat);
      }
      console.log(JSON.stringify({ok:true,gameId,seats:3,connectionFile:target,spectator:new URL('/?game='+gameId,origin).href}));
    }finally{await client.close();}return;
  }
  if(operation==='status'){console.log(JSON.stringify(await request('/api/games')));return;}
  console.log('Usage: pnpm cloud:admin status | export [--out file] | import --file file | new-match --game unique-id [--a name --b name --c name]');
}
main().catch(error=>{console.error('Cloud operation was not confirmed. Inspect status and the private recovery files before retrying.');console.error(String(error.message).replace(/[A-Za-z0-9_-]{32,}/g,'[redacted]').slice(0,300));process.exitCode=1;});
