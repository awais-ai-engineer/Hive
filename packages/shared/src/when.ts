export type ParsedWhen = { when: Date; rest: string };

/** Parse a reminder prefix in the viewer's local timezone; callers send the result as UTC. */
export function parseWhen(input: string, now = new Date()): ParsedWhen | null {
  if (!Number.isFinite(now.getTime())) return null;
  const text = input.trim();
  const relative = /^in\s+(\d+)(m|h|d)(?:\s+|$)/i.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const when = new Date(now.getTime() + amount * ({ m: 60000, h: 3600000, d: 86400000 }[unit] ?? 0));
    if (amount <= 0 || !Number.isFinite(when.getTime())) return null;
    return { when, rest: text.slice(relative[0].length).trim() };
  }
  const clock = /^(tomorrow|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s+|$)/i.exec(text);
  if (!clock) return null;
  let hours = Number(clock[2]);
  const minutes = Number(clock[3] ?? 0);
  const meridiem = clock[4]?.toLowerCase();
  if (minutes > 59 || (meridiem ? hours < 1 || hours > 12 : hours > 23)) return null;
  if (!meridiem && clock[3] === undefined) return null;
  if (meridiem) hours = hours % 12 + (meridiem === 'pm' ? 12 : 0);
  const when = new Date(now);
  if (clock[1].toLowerCase() === 'tomorrow') when.setDate(when.getDate() + 1);
  when.setHours(hours, minutes, 0, 0);
  // Missing or repeated wall-clock hours follow Date's documented local-time behavior.
  if (when.getTime() <= now.getTime()) return null;
  return { when, rest: text.slice(clock[0].length).trim() };
}
