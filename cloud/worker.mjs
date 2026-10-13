import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { AuthHandler, authority, internalRequest, isViewer } from './auth.mjs';
import { bounded, json, matches } from './security.mjs';
export { NightPortAuthority } from './authority.mjs';

function oauth(origin) { return new OAuthProvider({
  apiRoute:'/mcp',apiHandler:{async fetch(request,env,ctx){
    if(!ctx.auth?.scope?.includes('nightport:play')||!ctx.props?.seatKey)return json({error:'Forbidden'},403);
    return authority(env).fetch(internalRequest(request,'seat',ctx.props.seatKey));
  }},defaultHandler:AuthHandler,authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',
  scopesSupported:['nightport:play','offline_access'],requiredScopes:['nightport:play'],clientIdMetadataDocumentEnabled:false,
  accessTokenTTL:3600,refreshTokenTTL:30*86400,refreshTokenIdleTTL:30*86400,
  resourceMetadata:{resource:origin+'/mcp',authorization_servers:[origin]},
}); }
let provider,providerOrigin;

export default {async fetch(incoming,env,ctx) {
  const url=new URL(incoming.url);
  if(url.pathname==='/healthz'&&incoming.method==='GET')return json({ok:true,service:'night-port',version:'0.3.0',hosting:'cloudflare-workers',authoritative:true,storage:'durable-object-sqlite',localDependencies:false,access:'private'});
  if(incoming.headers.has('origin')&&incoming.headers.get('origin')!==url.origin)return json({error:'Origin rejected'},403);
  try {
    const origin=new URL(env.PUBLIC_ORIGIN).origin;
    if(url.origin!==origin)return json({error:'Unexpected deployment origin'},421);
    if(providerOrigin!==origin){provider=oauth(origin);providerOrigin=origin;}
    const request=await bounded(incoming,url.pathname==='/api/admin/import'?2*1024*1024:65536);
    const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    const admin=await matches(token,env.OPERATOR_KEY_SHA256);
    if(admin && (url.pathname.startsWith('/api/')||url.pathname==='/mcp/lobby')) {
      return authority(env).fetch(internalRequest(request,'admin',null,url.pathname==='/mcp/lobby'?'/mcp':undefined));
    }
    // Existing seat capabilities survive migration. New configurations use an Authorization header.
    const legacySeat=/^\/mcp\/seat\/([a-f0-9]{64})$/.exec(url.pathname);
    if(legacySeat||url.pathname==='/mcp/seat') {
      const key=legacySeat?.[1]||token;if(!/^[a-f0-9]{64}$/.test(key||''))return json({error:'Seat credential required'},401);
      return authority(env).fetch(internalRequest(request,'seat',key,'/mcp'));
    }
    if(url.pathname==='/login')return AuthHandler.fetch(request,env);
    if(url.pathname==='/mcp'||url.pathname.startsWith('/.well-known/')||['/authorize','/oauth/token','/oauth/register','/oauth/revoke'].includes(url.pathname))return provider.fetch(request,env,ctx);
    if(request.method!=='GET')return json({error:'Method not allowed'},405);
    if(!admin&&!await isViewer(request,env)) {
      if(url.pathname.startsWith('/api/'))return json({error:'Private deployment: authentication required'},401);
      return new Response(null,{status:303,headers:{location:'/login','cache-control':'no-store'}});
    }
    if(url.pathname.startsWith('/api/'))return authority(env).fetch(internalRequest(request,admin?'admin':'viewer'));
    if(!['/','/index.html','/app.js','/styles.css'].includes(url.pathname))return json({error:'Not found'},404);
    const response=await env.ASSETS.fetch(request);const output=new Response(response.body,response);
    output.headers.set('cache-control','no-store');output.headers.set('referrer-policy','no-referrer');output.headers.set('x-content-type-options','nosniff');
    output.headers.set('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    return output;
  }catch(error){return json({error:error.message==='request_too_large'?'Request too large':'Request was not confirmed'},error.message==='request_too_large'?413:500);}
}};
