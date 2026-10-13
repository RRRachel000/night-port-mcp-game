import { DurableObject } from 'cloudflare:workers';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { SqlGameStore } from './sql-store.ts';
import { WindowCoordinator } from '../src/window-coordinator.ts';
import { createWindowMcpServer } from '../src/window-mcp.ts';
import { createGameMcpServer } from '../src/mcp-tools.ts';
import { GameRuleError } from '../src/engine.ts';
import { json } from './security.mjs';

/** A deployment has exactly one authority. Never use user-supplied object names. */
export class NightPortAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new SqlGameStore(ctx.storage.sql);
    this.coordinator = new WindowCoordinator(this.store, { cloud: true });
  }
  async fetch(request) {
    const url = new URL(request.url);
    const role = request.headers.get('x-night-port-role');
    const seatKey = request.headers.get('x-night-port-seat');
    try {
      if (url.pathname === '/internal/seat' && role === 'seat') {
        const { gameId, route } = this.coordinator.resolveConnection(seatKey);
        return json({ gameId, playerId: route.playerId, generation: route.generation });
      }
      if (url.pathname === '/mcp') {
        if (!['admin','seat'].includes(role)) return json({error:'Unauthorized'},401);
        if (role === 'seat') this.coordinator.resolveConnection(seatKey);
        const handler = createMcpHandler(() => role === 'admin' ? createGameMcpServer(this.store) : createWindowMcpServer(this.coordinator, seatKey), {
          legacy:'stateless', responseMode:'json', onerror:()=>{},
        });
        const isList = request.method === 'POST' && (await request.clone().json()).method === 'tools/list';
        const response = await handler.fetch(request);
        if (isList && role === 'seat' && response.ok) {
          const schemes = [{type:'oauth2',scopes:['nightport:play']}];
          const annotate=payload=>{if(payload.result?.tools)payload.result.tools=payload.result.tools.map(tool=>({...tool,securitySchemes:schemes,_meta:{...tool._meta,securitySchemes:schemes}}));return payload;};
          if(response.headers.get('content-type')?.includes('application/json'))return json(annotate(await response.json()),response.status);
          // Legacy clients receive a finite SSE response even when modern responseMode is json.
          if(response.headers.get('content-type')?.includes('text/event-stream')){
            const body=(await response.text()).split('\n').map(line=>line.startsWith('data: ')?'data: '+JSON.stringify(annotate(JSON.parse(line.slice(6)))):line).join('\n');
            return new Response(body,{status:response.status,headers:response.headers});
          }
        }
        return response;
      }
      if (role !== 'admin' && role !== 'viewer') return json({error:'Unauthorized'},401);
      if (url.pathname === '/api/games' && request.method === 'GET') {
        return json({ok:true,games:this.store.listGameIds().map(gameId=>{
          const s=this.store.get(gameId).publicState(); return {gameId,gameName:s.gameName,phase:s.phase,round:s.round,stateVersion:s.stateVersion,summary:s.summary};
        })});
      }
      const gameMatch = /^\/api\/games\/([A-Za-z0-9_-]{1,100})(\/log)?$/.exec(url.pathname);
      if (gameMatch && request.method === 'GET') {
        const game=this.store.get(gameMatch[1]);
        if(gameMatch[2]) {const entries=game.fullLog(); const offset=Math.max(0,Number.parseInt(url.searchParams.get('offset')||'0')||0); const limit=Math.min(500,Math.max(1,Number.parseInt(url.searchParams.get('limit')||'200')||200)); return json({ok:true,total:entries.length,entries:entries.slice(offset,offset+limit)});}
        return json({ok:true,...game.publicState({includeProfitEstimates:true}),automation:this.coordinator.publicStatus(gameMatch[1])});
      }
      if(role !== 'admin') return json({error:'Forbidden'},403);
      if(url.pathname==='/api/admin/export' && request.method==='GET') {
        return json({schemaVersion:1,games:this.store.listGameIds().map(id=>this.store.exportSnapshot(id))});
      }
      if(url.pathname==='/api/admin/import' && request.method==='POST') {
        const body=await request.json();
        if(!Array.isArray(body.games)||body.games.length>100) return json({error:'Invalid import'},400);
        // Batch import is atomic, including conflicting IDs. Existing snapshots are never replaced.
        const imported=this.ctx.storage.transactionSync(()=>body.games.map(s=>this.store.importSnapshot(s)));
        return json({ok:true,imported});
      }
      if(url.pathname==='/api/referee' && request.method==='POST') {
        const b=await request.json(); let result;
        switch(b.operation) {
          case 'list': result={games:this.store.listGameIds().filter(id=>this.store.windowControl(id)).map(gameId=>({gameId,runtime:this.coordinator.publicStatus(gameId)}))};break;
          case 'status': result=this.coordinator.publicStatus(b.gameId);break;
          case 'bind': result=this.coordinator.bind(b.gameId,b.route,b.takeover===true);break;
          case 'pause': if(typeof b.paused!=='boolean')return json({error:'Invalid paused flag'},400);this.coordinator.setPaused(b.gameId,b.paused);result=this.coordinator.publicStatus(b.gameId);break;
          case 'claim': result={task:this.coordinator.claim(b.gameId),runtime:this.coordinator.publicStatus(b.gameId)};break;
          case 'report': result=this.coordinator.report(b.gameId,b.jobId,b.dispatchId,b.failure);break;
          default: return json({error:'Unknown command'},400);
        }
        return json({ok:true,result});
      }
      return json({error:'Not found'},404);
    } catch(error) {
      if(error instanceof GameRuleError) return json({ok:false,error:{code:error.code,message:error.message}},error.code==='CONNECTION_REVOKED'?401:409);
      if(error instanceof SyntaxError) return json({error:'Invalid JSON'},400);
      return json({error:'Request was not confirmed'},500);
    }
  }
}
