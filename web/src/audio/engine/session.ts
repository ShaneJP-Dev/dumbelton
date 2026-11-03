/**
 * Browser/iOS audio session handling:
 * - iOS mutes Web Audio with the silent switch unless the session type is 'playback'
 * - the context can become 'interrupted' (calls, Siri) or 'suspended' (autoplay policy)
 * - Screen Wake Lock keeps the iPad awake on stage
 */
type NavigatorWithSession = Navigator & { audioSession?: { type: string } };

export function configureAudioSession(): void {
  const nav = navigator as NavigatorWithSession;
  try {
    if (nav.audioSession) nav.audioSession.type = 'playback';
  } catch {
    /* not supported */
  }
}

/** Keep the context running: resume on the next user gesture or when the page becomes visible. */
export function keepAlive(ctx: AudioContext): () => void {
  const tryResume = () => {
    if (ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => undefined);
  };
  const events = ['pointerdown', 'keydown', 'touchend'];
  events.forEach((e) => window.addEventListener(e, tryResume, { capture: true }));
  document.addEventListener('visibilitychange', tryResume);
  ctx.addEventListener('statechange', tryResume);
  return () => {
    events.forEach((e) => window.removeEventListener(e, tryResume, { capture: true }));
    document.removeEventListener('visibilitychange', tryResume);
    ctx.removeEventListener('statechange', tryResume);
  };
}

let wakeLock: { release: () => Promise<void> } | null = null;

export async function requestWakeLock(): Promise<boolean> {
  const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
  if (!nav.wakeLock) return false;
  try {
    wakeLock = await nav.wakeLock.request('screen');
    return true;
  } catch {
    return false;
  }
}

export async function releaseWakeLock(): Promise<void> {
  try {
    await wakeLock?.release();
  } catch {
    /* already released */
  }
  wakeLock = null;
}
