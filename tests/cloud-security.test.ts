import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Cloud boundary helpers are also executed directly by Workers.
import { bounded, digest, matches } from '../cloud/security.mjs';
// @ts-expect-error The OAuth boundary is deliberately a runtime module.
import { AuthHandler } from '../cloud/auth.mjs';

test('private cloud credentials require exact configured hashes and bounded request bodies',async()=>{
  const key='a'.repeat(64);assert.equal(await matches(key,await digest(key)),true);
  assert.equal(await matches(key+'b',await digest(key)),false);assert.equal(await matches(key,undefined),false);
  const source=new ReadableStream({start(c){c.enqueue(new Uint8Array(40));c.close();}});
  await assert.rejects(()=>bounded(new Request('https://test.example',{method:'POST',body:source,duplex:'half'} as any),32),/request_too_large/);
});
test('OAuth form preserves same-origin submissions and rejects null Origin before granting a seat',async()=>{
  const kv=new Map<string,string>();let grants=0;
  const env={OAUTH_KV:{put:(k:string,v:string)=>kv.set(k,v),get:(k:string)=>kv.get(k),delete:(k:string)=>kv.delete(k)},OAUTH_PROVIDER:{
    parseAuthRequest:async()=>({clientId:'test',redirectUri:'https://chatgpt.com/callback',scope:['nightport:play']}),
    lookupClient:async()=>({clientName:'<script>bad</script>'}),completeAuthorization:async()=>{grants++;return {redirectTo:'https://chatgpt.com/callback?code=test'};}
  },AUTHORITY:{idFromName:(x:string)=>x,get:()=>({fetch:async()=>Response.json({gameId:'g',playerId:'a',generation:1})})}};
  const url='https://test.example/authorize?client_id=test';
  const page=await AuthHandler.fetch(new Request(url),env);
  assert.equal(page.headers.get('referrer-policy'),'same-origin');assert.equal((await page.text()).includes('<script>bad'),false);
  const cookie=page.headers.get('set-cookie').split(';')[0];const nonce=cookie.split('=')[1];
  const post=(origin:string)=>new Request(url,{method:'POST',headers:{origin,cookie},body:new URLSearchParams({nonce,key:'a'.repeat(64),decision:'allow'})});
  assert.equal((await AuthHandler.fetch(post('null'),env)).status,403);assert.equal(grants,0);
  assert.equal((await AuthHandler.fetch(post('https://test.example'),env)).status,200);assert.equal(grants,1);
  assert.equal((await AuthHandler.fetch(post('https://test.example'),env)).status,403);assert.equal(grants,1);
});
