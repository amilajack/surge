// The standalone verification host intentionally keeps its test /user backend
// in memory across editor/plugin recreation. Production hosts use durable I/O.
export function userFileRequest(store, request) {
  if (!store) throw new Error('Test user folder is not initialized');
  if (request.op === 'list') return {available: true, skipped: [], entries: [...store.entries]
    .filter(([path]) => path !== '/')
    .map(([path, entry]) => ({path: path.slice(1), kind: entry.type === 'dir' ? 2 : 1,
      mtime: entry.mtime, data: entry.data?.slice(), size: entry.data?.length ?? 0}))};
  if (request.op !== 'apply' || !Array.isArray(request.operations)) throw new Error('Invalid test user-file request');
  for (const {op, path, data} of request.operations) {
    if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') ||
        path.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('Invalid test user-file path');
    const target = '/' + path;
    const ok = op === 1 ? store.write(target, data) : op === 2 ? store.unlink(target)
      : op === 3 ? store.stat(target)?.type === 'dir' || store.mkdir(target)
      : op === 4 ? store.rmdir(target) : false;
    if (!ok) throw new Error('Test user-file operation failed: ' + path);
  }
  return true;
}
