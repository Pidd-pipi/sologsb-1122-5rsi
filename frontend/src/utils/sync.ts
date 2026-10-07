/**
 * 跨标签页变更广播。
 *
 * 同一浏览器里两个地质员（实际为两个标签页/窗口）同时编录同一掌子面时，
 * 一方保存后其他标签页立即收到通知并重新拉库，保证：
 * 1. 页面上看到的就是对方刚录的数据；
 * 2. 再保存时乐观锁（rev）能检出"对方刚改过"，而不是静默覆盖。
 */

export type SyncEntity = 'faces' | 'joints' | 'grades' | 'waters';

export interface SyncMessage {
  entity: SyncEntity;
  /** 变更记录 id；删除时为被删 id */
  id: string;
  /** 'save' 含新增/更新，'remove' 为删除 */
  action: 'save' | 'remove';
  at: number;
}

const CHANNEL_NAME = 'gbtunnelface:sync';

type Listener = (msg: SyncMessage) => void;

let channel: BroadcastChannel | null = null;
const listeners = new Set<Listener>();

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (e: MessageEvent<SyncMessage>) => {
    if (e.data && e.data.entity) listeners.forEach((fn) => fn(e.data));
  };
  return channel;
}

export function notifyChange(entity: SyncEntity, id: string, action: 'save' | 'remove' = 'save'): void {
  const msg: SyncMessage = { entity, id, action, at: Date.now() };
  ensureChannel()?.postMessage(msg);
}

export function onRemoteChange(fn: Listener): () => void {
  ensureChannel();
  listeners.add(fn);
  return () => listeners.delete(fn);
}
