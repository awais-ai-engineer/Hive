import { apiData } from './spaces';

export const gamesPath = (slug: string, rest = '') => `/api/spaces/${encodeURIComponent(slug)}/games${rest}`;
export const post = <T,>(path: string, body?: object) =>
  apiData<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

export type GamesSummary = {
  word: { status: 'playing' | 'won' | 'lost'; guesses: number };
  newQuizzes: number; openPredictions: number; canManage: boolean;
  badges: { topPlayer: boolean; wordStreak: number };
};

export type HubItem = { slug: string; name: string; wordStatus: 'playing' | 'won' | 'lost'; wordGuesses: number };

export type QuizSummary = {
  id: string; title: string; timeLimitS: number; status: 'draft' | 'published' | 'archived';
  questionCount: number; myState: 'new' | 'playing' | 'finished'; myScore: number | null; canEdit: boolean;
};
export type QuizQuestion = { id: string; position: number; text: string; options: string[]; correctIndex?: number };
export type QuizAdmin = QuizSummary & { questions: QuizQuestion[] };
export type QuizStart = { attemptId: string; startedAt: string; timeLimitS: number; questions: QuizQuestion[]; answeredIds: string[] };
export type QuizResult = {
  score: number; correctCount: number; total: number;
  results: (QuizQuestion & { choice: number | null; correct: boolean })[];
};

export type PredictionItem = {
  id: string; question: string; closesAt: string; points: number; status: 'open' | 'resolved' | 'canceled';
  resolvedOptionId: string | null; myOptionId: string | null; votingOpen: boolean;
  options: { id: string; label: string; votes: number }[];
};

export const statusText = (status: HubItem['wordStatus']) =>
  status === 'won' ? 'Solved today' : status === 'lost' ? 'Played today' : 'Not finished yet';
