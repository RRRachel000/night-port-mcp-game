export const secureHeaders = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function digest(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
export async function matches(secret, expected) {
  if (!expected || typeof secret !== 'string' || secret.length < 32 || secret.length > 256) return false;
  const actual = await digest(secret);
  let difference = actual.length ^ expected.length;
  for (let i=0;i<actual.length;i++) difference |= actual.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  return difference === 0;
}
export function json(body, status = 200, extra = {}) { return Response.json(body, { status, headers: { ...secureHeaders, ...extra } }); }
export function html(body, status = 200, extra = {}) {
  return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>不夜港 · 私人连接</title><style>body{font:17px system-ui;background:#101b26;color:#edf1f0;max-width:600px;margin:10vh auto;padding:24px;line-height:1.7}input,button,select{box-sizing:border-box;font:inherit;padding:12px;width:100%;margin:12px 0}button{background:#e2b06a;border:0;border-radius:8px;cursor:pointer}a{color:#e2b06a}</style><main>'+body+'</main></html>',{status,headers:{...secureHeaders,'content-type':'text/html;charset=utf-8',...extra}});
}
export async function bounded(request, limit=65536) {
  if (!request.body) return request;
  if (Number(request.headers.get('content-length')) > limit) throw new Error('request_too_large');
  const reader = request.body.getReader(); const chunks=[]; let length=0;
  for (;;) {const {value,done}=await reader.read(); if(done)break; length+=value.length; if(length>limit){await reader.cancel();throw new Error('request_too_large');} chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new Request(request.url,{method:request.method,headers:request.headers,body:bytes,redirect:request.redirect});
}
