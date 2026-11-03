/** Socket.IO event names shared by web and server. */
export const SocketEvents = {
  Ping: 'rtt:ping',
  MessageSend: 'message:send',
  MessageNew: 'message:new',
  TypingStart: 'typing:start',
  TypingStop: 'typing:stop',
  ReadUpdate: 'read:update',
  Sync: 'sync',
} as const;

export interface PingAck {
  serverTime: number;
}
