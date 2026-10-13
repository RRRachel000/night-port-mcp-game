import { digest, escapeHtml, html, json, matches } from './security.mjs';

export function authority(env) { return env.AUTHORITY.get(env.AUTHORITY.idFromName('private-authority')); }
export function internalRequest(request, role, seatKey, path) {
  const headers=new Headers(request.headers);
  headers.delete('authorization'); headers.delete('cookie'); headers.delete('x-night-port-seat'); headers.delete('x-night-port-role');
  headers.set('x-night-port-role',role);if(seatKey)headers.set('x-night-port-seat',seatKey);
  return new Request(path?new URL(path,request.url):request.url,{method:request.method,headers,body:request.body,redirect:'manual'});
}
const cookie = (name, value, ttl) => `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttl}`;
function cookieValue(request,name){return request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);}
async function formNonce(request,env) {
  const nonce=crypto.randomUUID();
  await env.OAUTH_KV.put('nonce:'+nonce,await digest(new URL(request.url).pathname+new URL(request.url).search),{expirationTtl:600});
  return {nonce,headers:{'set-cookie':cookie('__Host-nightport-nonce',nonce,600),'referrer-policy':'same-origin'}};
}
async function consumeForm(request,env) {
  const url=new URL(request.url);
  if(request.headers.get('origin')!==url.origin) return null;
  const form=await request.formData(); const nonce=String(form.get('nonce')||'');
  if(!/^[a-f0-9-]{36}$/.test(nonce)||cookieValue(request,'__Host-nightport-nonce')!==nonce)return null;
  const expected=await env.OAUTH_KV.get('nonce:'+nonce);
  if(!expected||expected!==await digest(url.pathname+url.search))return null;
  await env.OAUTH_KV.delete('nonce:'+nonce); return form;
}
export async function isViewer(request,env) {
  const session=cookieValue(request,'__Host-nightport-view');
  return !!session && /^[a-f0-9-]{36}$/.test(session) && (await env.OAUTH_KV.get('viewer:'+await digest(session)))==='viewer';
}
export const AuthHandler={async fetch(request,env) {
  const url=new URL(request.url);
  try {
    if(url.pathname==='/login') {
      if(request.method==='GET') {
        const n=await formNonce(request,env);
        return html(`<h1>不夜港 · 私人观战</h1><p>使用部署者的观战口令打开自己的存档。</p><form method="post"><input type="hidden" name="nonce" value="${n.nonce}"><label for="key">观战口令</label><input id="key" name="key" type="password" autocomplete="current-password" required minlength="32" maxlength="256"><button>进入观战台</button></form>`,200,n.headers);
      }
      if(request.method!=='POST')return json({error:'Method not allowed'},405);
      const form=await consumeForm(request,env);
      if(!form||!await matches(form.get('key'),env.VIEWER_PASSWORD_SHA256))return html('<h1>未能登录</h1><p>重新打开登录页并核对口令。</p><a href="/login">重试</a>',403);
      const session=crypto.randomUUID();await env.OAUTH_KV.put('viewer:'+await digest(session),'viewer',{expirationTtl:86400});
      return new Response(null,{status:303,headers:{location:'/', 'set-cookie':cookie('__Host-nightport-view',session,86400),'cache-control':'no-store'}});
    }
    if(url.pathname!=='/authorize')return json({error:'Not found'},404);
    const auth=await env.OAUTH_PROVIDER.parseAuthRequest(new Request(request.url));
    const client=await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
    const redirect=new URL(auth.redirectUri);
    if(redirect.protocol!=='https:'||redirect.username||redirect.password)return json({error:'HTTPS callback required'},400);
    if(request.method==='GET') {
      const n=await formNonce(request,env);
      return html(`<h1>连接我的不夜港席位</h1><p>允许 <strong>${escapeHtml(client?.clientName||'此客户端')}</strong> 读取并操作一个独立席位。</p><p>回调目标：${escapeHtml(redirect.origin)}。其他席位的隐藏成就不会授予此连接。</p><p>权限：读取本席位与提交行动（nightport:play）；若请求 offline_access，可在访问令牌过期后续期。客户端名称由其自行声明。</p><form method="post"><input name="nonce" type="hidden" value="${n.nonce}"><label for="key">此席位的私人连接口令</label><input id="key" name="key" type="password" autocomplete="current-password" required pattern="[a-f0-9]{64}" maxlength="64"><button name="decision" value="allow">连接此席位</button><button name="decision" value="deny" formnovalidate>取消</button></form>`,200,n.headers);
    }
    if(request.method!=='POST')return json({error:'Method not allowed'},405);
    const form=await consumeForm(request,env);if(!form)return json({error:'Connection page expired'},403);
    if(form.get('decision')!=='allow')return html('<h1>连接已取消</h1>');
    const key=String(form.get('key')||'');if(!/^[a-f0-9]{64}$/.test(key))return json({error:'Invalid seat phrase'},403);
    const identityResponse=await authority(env).fetch(internalRequest(new Request(url.origin+'/internal/seat'),'seat',key));
    if(!identityResponse.ok)return html('<h1>席位口令无效或已撤销</h1><p>请向本部署的管理员确认自己的席位连接。</p>',403);
    const identity=await identityResponse.json();
    const scope=[...new Set(auth.scope.filter(s=>['nightport:play','offline_access'].includes(s)))];
    if(!scope.includes('nightport:play'))return json({error:'Play scope required'},400);
    const grant=await env.OAUTH_PROVIDER.completeAuthorization({request:auth,userId:encodeURIComponent(`${identity.gameId}:${identity.playerId}:${identity.generation}`),metadata:{label:`${identity.gameId} / ${identity.playerId}`},scope,props:{seatKey:key},revokeExistingGrants:false});
    return html(`<h1>连接已授权</h1><p>现在返回客户端完成席位连接。</p><a href="${escapeHtml(grant.redirectTo)}">返回客户端，完成连接</a>`,200,{'set-cookie':cookie('__Host-nightport-nonce','',0)});
  }catch{return json({error:'Unable to authorize connection'},400);}
}};
