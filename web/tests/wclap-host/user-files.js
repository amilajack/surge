// The standalone verification host intentionally keeps its test /user backend
// in memory across editor/plugin recreation. Production hosts use durable I/O.
const lanes = new WeakMap();
const validToken = token => token === null || typeof token === 'string' && (token === 'directory' || /^file:[0-9a-f]{64}$/.test(token));
const hash = async bytes => 'file:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2,'0')).join('');
async function token(store,path) {
  const entry=store.stat('/'+path);
  return !entry ? null : entry.type==='dir' ? 'directory' : hash(store.read('/'+path).slice());
}
async function requestStore(store,request) {
  if (!store) throw new Error('Test user folder is not initialized');
  if (request.protocol !== 2) throw new Error('Update this plug-in to use conflict-safe user files');
  if (request.op === 'list') return {protocol:2,available:true,skipped:[],entries:await Promise.all([...store.entries]
    .filter(([path]) => path !== '/')
    .map(async ([path,entry]) => ({path:path.slice(1),kind:entry.type==='dir'?2:1,mtime:entry.mtime,
      data:entry.data?.slice(),size:entry.data?.length??0,token:await token(store,path.slice(1))})))};
  if (request.op !== 'apply' || request.protocol !== 2 || !Array.isArray(request.operations)) throw new Error('Invalid conflict-safe user-file request');
  const expected=new Map(),desired=new Map();
  for(const operation of request.operations) {
    const {op,path,data}=operation;
    if(typeof path!=='string'||!path||path.includes('\\')||path.includes('\0')||path.split('/').some(part=>!part||part==='.'||part==='..')||
       !Object.hasOwn(operation,'expected')||!validToken(operation.expected)||![1,2,3,4].includes(op))throw new Error('Invalid test user-file path or base token');
    if(expected.has(path)&&expected.get(path)!==operation.expected)throw new Error('Inconsistent initial user-file base token');
    expected.set(path,operation.expected);
    desired.set(path,op===1?await hash(data):op===3?'directory':null);
  }
  const already=new Set();
  for(const [path,base]of expected) {
    const current=await token(store,path);
    if(current!==base) {
      if(current!==desired.get(path))throw new Error('User-file conflict: '+path+' changed in another editor. Local changes remain in this window.');
      already.add(path);
    }
  }
  for(const {op,path,data}of request.operations) {
    if(already.has(path))continue;
    const target='/'+path;
    const ok=op===1?store.write(target,data):op===2?store.unlink(target):op===3?store.stat(target)?.type==='dir'||store.mkdir(target):store.rmdir(target);
    if(!ok)throw new Error('Test user-file operation failed: '+path);
  }
  return {protocol:2,versions:await Promise.all([...expected.keys()].map(async path=>({path,token:await token(store,path)})))};
}
export function userFileRequest(store,request) {
  if(!store||typeof store!=='object')return Promise.reject(new Error('Test user folder is not initialized'));
  const result=(lanes.get(store)||Promise.resolve()).catch(()=>{}).then(()=>requestStore(store,request));
  lanes.set(store,result.catch(()=>{}));
  return result;
}
