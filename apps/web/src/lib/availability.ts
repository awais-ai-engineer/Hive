'use client';
import { useEffect, useState } from 'react';
import { apiData } from './spaces';
import { socket } from './socket';
export type Availability = { userId: string; status: string; message: string | null; until: string | null; blocked: string[]; suppressNotifications: boolean };
export function useAvailability(channelId: string, enabled = true) {
  const [people, setPeople] = useState<Availability[]>([]);
  useEffect(() => {
    if (!enabled) { setPeople([]); return; }
    setPeople([]);
    let active = true;
    const load = () => apiData<Availability[]>(`/api/channels/${channelId}/availability`).then(value => { if (active) setPeople(value); }).catch(() => {});
    void load();
    const timer = setInterval(() => void load(), 15000);
    socket.on('availability:changed', load).on('connect', load);
    window.addEventListener('focus', load);
    return () => { active = false; clearInterval(timer); socket.off('availability:changed', load).off('connect', load); window.removeEventListener('focus', load); };
  }, [channelId, enabled]);
  return people;
}
export function availabilityMessage(person: Availability) {
  const until = person.until ? new Date(person.until).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  return `This user is currently ${person.status.replaceAll('_', ' ')}${until ? ` and will be available at ${until}` : ''}.${person.message ? ` ${person.message}` : ''}`;
}
