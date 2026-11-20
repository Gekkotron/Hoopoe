import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LockProvider, useLock, LOCK_FLAG_KEY } from '../LockContext';
import { api } from '../../api/client';

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  api: vi.fn(),
}));
const mockedApi = vi.mocked(api);

function Probe() {
  const lock = useLock();
  return (
    <div>
      <span data-testid="locked">{String(lock.locked)}</span>
      <span data-testid="available">{String(lock.lockAvailable)}</span>
      <button onClick={lock.lockNow}>lock</button>
      <button onClick={() => void lock.unlock('pw').catch(() => {})}>unlock</button>
    </div>
  );
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LockProvider><Probe /></LockProvider>
    </QueryClientProvider>,
  );
}

// Flush pending promises and zero-delay timers (react-query's notify
// batching) without moving the clock. `runOnlyPendingTimersAsync()` jumps to
// the last pending timer, which is react-query's 5-minute GC timer; React 19
// arms the idle timer inside that same act(), so it would fire too.
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  document.documentElement.classList.remove('privacy-on');
  mockedApi.mockReset();
  // Default: LAN session mode, lock always available.
  mockedApi.mockImplementation(async (path: string) => {
    if (path === '/api/auth/lock-status') return { mode: 'session', lockConfigured: true };
    if (path === '/api/auth/verify') return { ok: true };
    throw new Error(`unexpected api call: ${path}`);
  });
});

afterEach(() => vi.useRealTimers());

describe('LockContext', () => {
  it('locks after 5 minutes idle and mirrors privacy-on onto <html>', async () => {
    mount();
    await settle(); // settle lock-status query
    expect(screen.getByTestId('locked').textContent).toBe('false');
    act(() => { vi.advanceTimersByTime(5 * 60 * 1000); });
    expect(screen.getByTestId('locked').textContent).toBe('true');
    expect(document.documentElement.classList.contains('privacy-on')).toBe(true);
    expect(localStorage.getItem(LOCK_FLAG_KEY)).toBe('1');
  });

  it('lockNow() locks immediately', async () => {
    mount();
    await settle();
    fireEvent.click(screen.getByText('lock'));
    expect(screen.getByTestId('locked').textContent).toBe('true');
  });

  it('boots locked when the localStorage flag is present', () => {
    localStorage.setItem(LOCK_FLAG_KEY, '1');
    mount();
    expect(screen.getByTestId('locked').textContent).toBe('true');
  });

  it('unlock() verifies server-side, then clears state and flag', async () => {
    localStorage.setItem(LOCK_FLAG_KEY, '1');
    mount();
    fireEvent.click(screen.getByText('unlock'));
    await settle();
    expect(mockedApi).toHaveBeenCalledWith('/api/auth/verify', {
      method: 'POST', json: { password: 'pw' },
    });
    expect(screen.getByTestId('locked').textContent).toBe('false');
    expect(localStorage.getItem(LOCK_FLAG_KEY)).toBeNull();
  });

  it('never arms the timer when no lock is configured (desktop default)', async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === '/api/auth/lock-status') return { mode: 'none', lockConfigured: false };
      throw new Error(`unexpected api call: ${path}`);
    });
    mount();
    await settle();
    expect(screen.getByTestId('available').textContent).toBe('false');
    act(() => { vi.advanceTimersByTime(10 * 60 * 1000); });
    expect(screen.getByTestId('locked').textContent).toBe('false');
  });

  it('force-unlocks a stale flag when the lock was reset out-of-band', async () => {
    // Desktop recovery: curl reset cleared the hash, but the old flag remains.
    localStorage.setItem(LOCK_FLAG_KEY, '1');
    mockedApi.mockImplementation(async (path: string) => {
      if (path === '/api/auth/lock-status') return { mode: 'none', lockConfigured: false };
      throw new Error(`unexpected api call: ${path}`);
    });
    mount();
    await settle();
    await waitFor(() => expect(screen.getByTestId('locked').textContent).toBe('false'));
    expect(localStorage.getItem(LOCK_FLAG_KEY)).toBeNull();
  });

  it('activity resets the idle countdown', async () => {
    mount();
    await settle();
    act(() => { vi.advanceTimersByTime(4 * 60 * 1000); });
    act(() => { window.dispatchEvent(new MouseEvent('mousemove')); });
    act(() => { vi.advanceTimersByTime(4 * 60 * 1000); });
    expect(screen.getByTestId('locked').textContent).toBe('false');
    act(() => { vi.advanceTimersByTime(60 * 1000); });
    expect(screen.getByTestId('locked').textContent).toBe('true');
  });
});
