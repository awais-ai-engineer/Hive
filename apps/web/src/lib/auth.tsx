'use client';

import { configureSounds, suppressSounds, type SoundPreferences } from './sounds';
import { apiData } from './spaces';
import { socket } from './socket';
import { createContext, useContext, useEffect, useState } from 'react';
import type { LoginInput, SignupInput } from '@hive/shared';
import { unsubscribeThisDevice } from './push';
import {
  apiFetch, endSession, refreshSession, responseData, setSession, subscribeSession, updateSessionUser,
  type AuthSession, type User,
} from './api';

type AuthContextValue = {
  user: User | null;
  accessToken: string | null;
  loading: boolean;
  signup: (input: SignupInput) => Promise<void>;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (user: User) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, updateSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribeSession(updateSession);
    let active = true;
    refreshSession().finally(() => { if (active) setLoading(false); });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session?.user.id) { suppressSounds(true); return; }
    let active = true;
    const refreshAvailability = async () => {
      try {
        const state = await apiData<{ sounds: SoundPreferences; suppress: boolean }>('/api/me/communication-state');
        if (active) { configureSounds(state.sounds); suppressSounds(state.suppress); }
      } catch { /* keep the current suppression choice on transient errors */ }
    };
    void refreshAvailability();
    const timer = setInterval(() => void refreshAvailability(), 15000);
    socket.on('availability:changed', refreshAvailability).on('connect', refreshAvailability);
    return () => { active = false; clearInterval(timer); socket.off('availability:changed', refreshAvailability).off('connect', refreshAvailability); };
  }, [session?.user.id]);

  async function authenticate(endpoint: string, input: LoginInput | SignupInput) {
    const response = await apiFetch(`/api/auth/${endpoint}`, {
      method: 'POST', body: JSON.stringify(input),
    });
    setSession(await responseData<AuthSession>(response));
  }

  return (
    <AuthContext.Provider value={{
      user: session?.user ?? null,
      accessToken: session?.access_token ?? null,
      loading,
      signup: input => authenticate('signup', input),
      login: input => authenticate('login', input),
      logout: async () => { await unsubscribeThisDevice().catch(() => {}); await endSession(); },
      updateUser: updateSessionUser,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is required');
  return context;
}
