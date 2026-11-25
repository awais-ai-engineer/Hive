import type { CSSProperties } from 'react';
/** Fixed geometry across select, disclosure and split-button controls. */
export function Chevron({ right = false, style }: { right?: boolean; style?: CSSProperties }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, aspectRatio: '1 / 1', ...style }}><path d={right ? 'm9 6 6 6-6 6' : 'm6 9 6 6 6-6'} /></svg>;
}
