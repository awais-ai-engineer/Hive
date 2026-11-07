import { z } from 'zod';

export const guessSchema = z.object({ guess: z.string().length(5).regex(/^[a-zA-Z]+$/) });
export type GuessInput = z.infer<typeof guessSchema>;

export const quizSchema = z.object({
  title: z.string().trim().min(1).max(80),
  timeLimitS: z.number().int().min(5).max(120).default(20),
});
export const questionSchema = z.object({
  text: z.string().trim().min(1).max(200),
  options: z.array(z.string().trim().min(1).max(80)).length(4),
  correctIndex: z.number().int().min(0).max(3),
});
export const predictionSchema = z.object({
  question: z.string().trim().min(1).max(200),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(6),
  closesAt: z.string(),
  points: z.number().int().min(1).max(100).default(10),
});
export type QuestionInput = z.infer<typeof questionSchema>;
export type PredictionInput = z.infer<typeof predictionSchema>;

export type LetterState = 'correct' | 'present' | 'absent';
export type WordState = {
  day: string; guesses: { letter: string; state: LetterState }[][]; status: 'playing' | 'won' | 'lost';
  maxGuesses: number; answer: string | null; points: number | null; share: string | null;
};
export type LeaderEntry = {
  rank: number; points: number; topPlayer: boolean;
  user: { id: string; username: string; displayName: string | null; avatarUrl: string | null };
};
export type Leaderboard = { period: string; game: string | null; entries: LeaderEntry[]; me: LeaderEntry | null };
