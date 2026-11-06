export type StatusFields = {
  status_emoji?: string | null;
  status_text?: string | null;
  status_expires_at?: string | null;
  out_of_office_until?: string | null;
};

const today = () => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); };

/** "3:30 PM" for later today, otherwise "Mon, Nov 9, 3:30 PM". */
export function untilText(iso: string) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? time
    : `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** Parses a plain "YYYY-MM-DD" date as a local day (not UTC). */
export function localDay(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export const dayText = (value: string) => localDay(value).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

/** The status to show: empty once it has expired (the server already hides expired ones). */
export function activeStatus(person: StatusFields) {
  const expired = !!person.status_expires_at && new Date(person.status_expires_at).getTime() <= Date.now();
  const emoji = expired ? null : person.status_emoji ?? null;
  const text = expired ? null : person.status_text ?? null;
  const away = person.out_of_office_until && localDay(person.out_of_office_until) >= today() ? person.out_of_office_until : null;
  return { emoji, text, until: expired ? null : person.status_expires_at ?? null, away };
}

/** Tooltip text such as "🗓️ In a meeting · until 3:30 PM". */
export function statusTitle(person: StatusFields) {
  const status = activeStatus(person);
  const parts = [`${status.emoji ?? ''} ${status.text ?? ''}`.trim()];
  if (parts[0] && status.until) parts[0] += ` · until ${untilText(status.until)}`;
  if (status.away) parts.push(`Out of office until ${dayText(status.away)}`);
  return parts.filter(Boolean).join('\n') || undefined;
}
