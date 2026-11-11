'use client';

import { Button as UiButton } from '@hive/ui';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SocketEvents, type HealthResponse, type PingAck } from '@hive/shared';
import { PolicyLinks } from '../../components/policies/policy-layout';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').trim().replace(/\/+$/, '');

type State = 'up' | 'down' | 'checking';

function Dot({ state }: { state: State }) {
  const color = state === 'up' ? 'bg-emerald-400' : state === 'down' ? 'bg-rose-500' : 'bg-amber-400';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

function Row({ name, detail, state }: { name: string; detail: string; state: State }) {
  return (
    <li className="flex items-center justify-between border-b border-white/5 py-3 last:border-0">
      <div>
        <div className="font-medium">{name}</div>
        <div className="text-sm text-white/50">{detail}</div>
      </div>
      <div className="flex items-center gap-2 text-sm text-white/70">
        <Dot state={state} />
        {state}
      </div>
    </li>
  );
}

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [apiState, setApiState] = useState<State>('checking');
  const [socketState, setSocketState] = useState<State>('checking');
  const [latency, setLatency] = useState<number | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_URL}/api/health`, { cache: 'no-store' });
        const data = (await res.json()) as HealthResponse;
        if (!cancelled) {
          setHealth(data);
          setApiState('up');
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
          setApiState('down');
        }
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const socket = io(API_URL, { transports: ['websocket'] });
    socketRef.current = socket;
    socket.on('connect', () => setSocketState('up'));
    socket.on('disconnect', () => setSocketState('down'));
    socket.on('connect_error', () => setSocketState('down'));
    return () => {
      socket.disconnect();
    };
  }, []);

  const ping = () => {
    const sent = performance.now();
    socketRef.current?.emit(SocketEvents.Ping, {}, (_ack: PingAck) => {
      setLatency(Math.round(performance.now() - sent));
    });
  };

  const svc = (s?: 'up' | 'down'): State => (apiState === 'down' ? 'down' : (s ?? 'checking'));

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-4xl font-bold tracking-tight">🐝 Hive</h1>
      <p className="mt-2 text-white/60">
        Communities, real-time chat, and voice rooms. This page checks that every part of the stack
        is running.
      </p>

      <section className="mt-10 rounded-xl border border-white/10 bg-white/[0.03] px-5">
        <ul>
          <Row name="Web" detail="Next.js on :3000" state="up" />
          <Row name="API" detail="Python FastAPI on :4000" state={apiState} />
          <Row name="Realtime" detail="Socket.IO gateway" state={socketState} />
          <Row name="PostgreSQL" detail="Docker on :5434" state={svc(health?.services.postgres)} />
          <Row name="Redis" detail="Docker on :6380" state={svc(health?.services.redis)} />
          <Row name="Moderation" detail="FastAPI on :8000" state={svc(health?.services.moderation)} />
        </ul>
      </section>

      <div className="mt-6 flex items-center gap-4">
        <UiButton
          onClick={ping}
          disabled={socketState !== 'up'}
          className="rounded-lg bg-amber-400 px-4 py-2 font-medium text-black disabled:opacity-40"
        >
          Ping server over WebSocket
        </UiButton>
        {latency !== null && <span className="text-white/70">Round trip: {latency} ms</span>}
      </div>
      <footer className="mt-12 border-t border-white/10 pt-6"><PolicyLinks /></footer>
    </main>
  );
}
