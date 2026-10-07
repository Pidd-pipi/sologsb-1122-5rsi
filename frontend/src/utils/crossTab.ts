/**
 * 跨标签页数据同步：任一标签页写入本地库后广播，其它标签页收到后
 * 重新加载各 store，保证两人同时编录时看到的是对方刚保存的数据。
 */
const CHANNEL_NAME = 'gbtunnelface:sync';

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** 本标签页写库后广播（BroadcastChannel 不会回发给本页） */
export function notifyDataChanged(): void {
  try {
    getChannel()?.postMessage({ at: Date.now() });
  } catch {
    /* 广播失败不影响本地写入 */
  }
}

/** 订阅其它标签页的写库广播，返回取消订阅函数 */
export function onCrossTabDataChanged(listener: () => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const handler = () => listener();
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}
