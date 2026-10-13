import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const directory=path.join(root,'.local/cloud');
const wrangler=path.join(root,'node_modules/wrangler/bin/wrangler.js');
const run=args=>{const r=spawnSync(process.execPath,[wrangler,...args],{cwd:root,encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error(`Wrangler ${args[0]} failed. Check authentication and run the command manually.`);return r.stdout;};
await fs.mkdir(directory,{recursive:true});
const configFile=path.join(directory,'wrangler.jsonc');
const originArg=process.argv.find(a=>a.startsWith('--origin='))?.slice(9);
if(originArg){const url=new URL(originArg);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('--origin must be the HTTPS origin of your Worker.');}
let config;
try{config=JSON.parse(await fs.readFile(configFile,'utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;
  config=JSON.parse(await fs.readFile(path.join(root,'cloud/wrangler.jsonc'),'utf8'));
  const name=process.argv.find(a=>a.startsWith('--name='))?.slice(7)||config.name;
  if(!/^[a-z][a-z0-9-]{1,62}$/.test(name))throw new Error('Invalid Worker name.');
  config.name=name;config.main='../../cloud/worker.mjs';config.assets.directory='../../public';config.$schema='../../node_modules/wrangler/config-schema.json';
  if(!originArg)throw new Error('First setup requires --origin=https://WORKER.YOUR-SUBDOMAIN.workers.dev');
  const output=run(['kv','namespace','create','OAUTH_KV','--config',path.join(root,'cloud/wrangler.jsonc')]);
  const id=output.match(/"id"\s*:\s*"([a-f0-9]{32})"/)?.[1];
  if(!id)throw new Error('KV created, but its ID was not parsed. Inspect Wrangler output before retrying.');
  config.kv_namespaces=[{binding:'OAUTH_KV',id}];
  await fs.writeFile(configFile,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
}
if(originArg)config.vars={...config.vars,PUBLIC_ORIGIN:new URL(originArg).origin};
if(!config.vars?.PUBLIC_ORIGIN)throw new Error('Add --origin=https://WORKER.YOUR-SUBDOMAIN.workers.dev');
await fs.writeFile(configFile,JSON.stringify(config,null,2)+'\n',{mode:0o600});
await fs.writeFile(path.join(directory,'connection.json'),JSON.stringify({origin:config.vars.PUBLIC_ORIGIN},null,2)+'\n',{mode:0o600});
const credentialFile=path.join(directory,'credentials.json');
let credentials;
try{credentials=JSON.parse(await fs.readFile(credentialFile,'utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;
  const operatorFile=path.join(root,'.local/operator.key');let operator;
  try{operator=(await fs.readFile(operatorFile,'utf8')).trim();}catch(error){if(error.code!=='ENOENT')throw error;operator=randomBytes(32).toString('hex');await fs.writeFile(operatorFile,operator,{mode:0o600,flag:'wx'});}
  if(!/^[a-f0-9]{64}$/.test(operator))throw new Error('Invalid operator key.');
  credentials={operator,viewerPhrase:randomBytes(32).toString('hex')};
  await fs.writeFile(credentialFile,JSON.stringify(credentials,null,2)+'\n',{mode:0o600,flag:'wx'});
  await fs.writeFile(path.join(directory,'viewer-connection.txt'),credentials.viewerPhrase+'\n',{mode:0o600,flag:'wx'});
}
const hash=s=>createHash('sha256').update(s).digest('hex');
const secretFile=path.join(directory,'worker-secrets.json');
await fs.writeFile(secretFile,JSON.stringify({OPERATOR_KEY_SHA256:hash(credentials.operator),VIEWER_PASSWORD_SHA256:hash(credentials.viewerPhrase)}),{mode:0o600});
run(['secret','bulk',secretFile,'--config',configFile]);
console.log('Private configuration and secrets are ready. Run pnpm cloud:deploy. Credentials remain in .local/cloud; do not commit or share them.');
