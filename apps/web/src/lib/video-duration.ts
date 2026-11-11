import type { SyntheticEvent } from 'react';

/**
 * Browser recordings (MediaRecorder WebM) carry no duration, so the player shows a timeline
 * that keeps counting and a black first frame. Seeking to the end once makes the browser
 * work the duration out; seeking back to 0 paints the first frame.
 */
export function fixVideoDuration(event: SyntheticEvent<HTMLVideoElement>) {
  const video = event.currentTarget;
  if (Number.isFinite(video.duration) || video.dataset.durationFixed) return;
  video.dataset.durationFixed = '1';
  const back = () => { video.removeEventListener('timeupdate', back); video.currentTime = 0; };
  video.addEventListener('timeupdate', back);
  video.currentTime = 1e101;
}
