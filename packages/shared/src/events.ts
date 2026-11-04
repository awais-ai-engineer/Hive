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
  ReadUpdated: 'read:updated',
  ReactionToggle: 'reaction:toggle',
  ReactionUpdated: 'reaction:updated',
  ChannelActivity: 'channel:activity',
  Presence: 'presence',
  DmActivity: 'dm:activity',
  SpaceWatch: 'space:watch',
  SpaceUnwatch: 'space:unwatch',
  ThreadRead: 'thread:read',
  ThreadActivity: 'thread:activity',
  Sync: 'sync',
  PostNew: 'post:new',
  PostScore: 'post:score',
} as const;

export interface PingAck {
  serverTime: number;
}
