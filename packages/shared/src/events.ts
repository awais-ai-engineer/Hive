/** Socket.IO event names shared by web and server. */
export const SocketEvents = {
  Ping: 'rtt:ping',
  MessageSend: 'message:send',
  MessageNew: 'message:new',
  ChannelJoin: 'channel:join',
  ChannelLeave: 'channel:leave',
  MessageEdit: 'message:edit',
  MessageDelete: 'message:delete',
  MessageUpdated: 'message:updated',
  MessageDeleted: 'message:deleted',
  Typing: 'typing',
  TypingStart: 'typing:start',
  TypingStop: 'typing:stop',
  ReadUpdate: 'read:update',
  Sync: 'sync',
} as const;

export interface PingAck {
  serverTime: number;
}
