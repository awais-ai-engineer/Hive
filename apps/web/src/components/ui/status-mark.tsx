import { activeStatus, dayText, statusTitle, type StatusFields } from '../../lib/status';

/** A person's status emoji (hover for the text and end time) and a palm tree while out of office. */
export function StatusMark({ person, className = '' }: { person: StatusFields; className?: string }) {
  const status = activeStatus(person);
  if (!status.emoji && !status.text && !status.away) return null;
  const title = statusTitle(person);
  return <span className={`inline-flex shrink-0 items-center gap-0.5 ${className}`} title={title}>
    {(status.emoji || status.text) && <span aria-label={title}>{status.emoji ?? '💬'}</span>}
    {status.away && <span role="img" aria-label={`Out of office until ${dayText(status.away)}`}>🌴</span>}
  </span>;
}
