// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'

const api = { getStoreAppStatus: vi.fn() }
vi.mock('@food/api', () => ({ restaurantAPI: { getStoreAppStatus: (...a) => api.getStoreAppStatus(...a) } }))

import {
  buildPatch,
  closedReasonText,
  customerChip,
  draftProblem,
  formatAgo,
  instantChip,
  isDirty,
  posChip,
} from '../src/modules/Food/pages/admin/apptimings/appTimingsUtils.js'
import usePosHeartbeat, { POS_HEARTBEAT_MS } from '../src/modules/Food/components/restaurant/pos/usePosHeartbeat.js'
import useStoreAppStatus, { APP_STATUS_REFRESH_MS } from '../src/modules/Food/hooks/useStoreAppStatus.js'

beforeEach(() => {
  vi.useFakeTimers()
  api.getStoreAppStatus.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the wording on the admin screen', () => {
  it('says how long ago in the biggest sensible unit', () => {
    expect(formatAgo(0)).toBe('0s ago')
    expect(formatAgo(11)).toBe('11s ago')
    expect(formatAgo(59)).toBe('59s ago')
    expect(formatAgo(60)).toBe('1m ago')
    expect(formatAgo(3599)).toBe('59m ago')
    expect(formatAgo(3600)).toBe('1h ago')
    expect(formatAgo(86400 * 2)).toBe('2d ago')
    expect(formatAgo(null)).toBe('')
    expect(formatAgo(-5)).toBe('')
  })

  it('describes the till', () => {
    expect(posChip({ pos: { online: true, secondsAgo: 11 } })).toEqual({ tone: 'green', text: 'POS online · seen 11s ago' })
    expect(posChip({ pos: { online: false, secondsAgo: 300 } })).toEqual({ tone: 'red', text: 'POS offline · last seen 5m ago' })
    expect(posChip({ pos: { online: false, secondsAgo: null } })).toEqual({ tone: 'red', text: 'POS offline · never seen' })
    expect(posChip({}).tone).toBe('red')
  })

  it('describes the customer app and instant delivery', () => {
    expect(customerChip({ customerOpen: true }).text).toBe('Customer app open')
    expect(customerChip({ customerOpen: false }).text).toBe('Customer app closed')
    expect(instantChip({ instantLive: true }).text).toBe('Instant live')
    expect(instantChip({ instantLive: false }).text).toBe('Instant off')
  })

  it('explains why the app is closed, and says nothing while it is open', () => {
    expect(closedReasonText({ customerOpen: true, reason: 'open' })).toBe('')
    expect(closedReasonText({ customerOpen: false, reason: 'pos-offline' })).toBe('App: POS is offline')
    expect(closedReasonText({ customerOpen: false, reason: 'app-forced-closed' })).toMatch(/closed by the admin/)
    expect(closedReasonText({ customerOpen: false, reason: 'not-accepting-orders' })).toMatch(/paused/)
    expect(closedReasonText({ customerOpen: false, reason: 'something-new' })).toBe('App: closed')
  })
})

describe('what a save sends', () => {
  const saved = { customerMode: 'follow', openTime: '06:00', closeTime: '22:00', instantMode: 'follow', instantFrom: '07:00', instantTo: '21:00', closedMessage: '', requirePosOnline: false }

  it('is only what changed', () => {
    expect(buildPatch(saved, { ...saved, customerMode: 'closed', closedMessage: 'Back at 4' })).toEqual({ customerMode: 'closed', closedMessage: 'Back at 4' })
  })

  it('is nothing for an untouched or missing draft', () => {
    expect(buildPatch(saved, { ...saved })).toEqual({})
    expect(buildPatch(saved, undefined)).toEqual({})
    expect(isDirty(saved, { ...saved })).toBe(false)
    expect(isDirty(saved, { ...saved, requirePosOnline: true })).toBe(true)
  })

  it('can clear a time by sending an empty string', () => {
    expect(buildPatch(saved, { ...saved, openTime: '', closeTime: '' })).toEqual({ openTime: '', closeTime: '' })
  })

  it('refuses half a window and an over-long message', () => {
    expect(draftProblem({ ...saved, openTime: '', closeTime: '22:00' })).toMatch(/both the app/)
    expect(draftProblem({ ...saved, instantFrom: '07:00', instantTo: '' })).toMatch(/both the instant/)
    expect(draftProblem({ ...saved, closedMessage: 'x'.repeat(281) })).toMatch(/280/)
    expect(draftProblem({ ...saved, openTime: '', closeTime: '' })).toBe('')
    expect(draftProblem(saved)).toBe('')
  })
})

describe('the till checking in', () => {
  it('checks in at once, then every 20 seconds', () => {
    const ping = vi.fn().mockResolvedValue({})
    renderHook(() => usePosHeartbeat(ping))
    expect(ping).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(POS_HEARTBEAT_MS)
    expect(ping).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(POS_HEARTBEAT_MS * 3)
    expect(ping).toHaveBeenCalledTimes(5)
  })

  it('stops when the till closes', () => {
    const ping = vi.fn().mockResolvedValue({})
    const { unmount } = renderHook(() => usePosHeartbeat(ping))
    unmount()
    vi.advanceTimersByTime(POS_HEARTBEAT_MS * 5)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('is not restarted by a new function each render', () => {
    const pings = []
    const { rerender } = renderHook(() => {
      const fn = vi.fn().mockResolvedValue({})
      pings.push(fn)
      usePosHeartbeat(fn)
    })
    rerender()
    rerender()
    vi.advanceTimersByTime(POS_HEARTBEAT_MS)
    // one on mount (the first function), one from the timer (the latest function)
    expect(pings[0]).toHaveBeenCalledTimes(1)
    expect(pings[pings.length - 1]).toHaveBeenCalledTimes(1)
  })

  it('carries on after a failed check-in, and after one that throws', () => {
    const ping = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => { throw new Error('boom') }).mockResolvedValue({})
    renderHook(() => usePosHeartbeat(ping))
    vi.advanceTimersByTime(POS_HEARTBEAT_MS * 2)
    expect(ping).toHaveBeenCalledTimes(3)
  })

  it('checks in again when the tab comes back to the front', () => {
    const ping = vi.fn().mockResolvedValue({})
    renderHook(() => usePosHeartbeat(ping))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(ping).toHaveBeenCalledTimes(2)
  })

  it('does nothing without a ping function', () => {
    expect(() => renderHook(() => usePosHeartbeat(undefined))).not.toThrow()
  })
})

const answer = (data) => Promise.resolve({ data: { data } })
const flush = async () => {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('what the cart knows about the store', () => {
  it('is null until the server answers, then the answer', async () => {
    api.getStoreAppStatus.mockReturnValue(answer({ open: false, message: 'Back at 4 pm.', instantLive: false }))
    const { result } = renderHook(() => useStoreAppStatus('store1'))
    expect(result.current).toBeNull()
    await flush()
    expect(result.current).toMatchObject({ open: false, message: 'Back at 4 pm.' })
    expect(api.getStoreAppStatus).toHaveBeenCalledWith('store1')
  })

  it('asks again every few seconds and shows the new answer', async () => {
    api.getStoreAppStatus.mockReturnValueOnce(answer({ open: true, instantLive: true })).mockReturnValue(answer({ open: false, instantLive: false }))
    const { result } = renderHook(() => useStoreAppStatus('store1'))
    await flush()
    expect(result.current.open).toBe(true)
    await act(async () => {
      vi.advanceTimersByTime(APP_STATUS_REFRESH_MS)
    })
    await flush()
    expect(result.current.open).toBe(false)
  })

  it('keeps the last answer when the server cannot be reached', async () => {
    api.getStoreAppStatus.mockReturnValueOnce(answer({ open: true })).mockRejectedValue(new Error('network'))
    const { result } = renderHook(() => useStoreAppStatus('store1'))
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(APP_STATUS_REFRESH_MS * 2)
    })
    await flush()
    expect(result.current.open).toBe(true)
  })

  it('does not ask without a store, and does not show another store\'s answer', async () => {
    const { result, rerender } = renderHook(({ id }) => useStoreAppStatus(id), { initialProps: { id: null } })
    expect(api.getStoreAppStatus).not.toHaveBeenCalled()
    expect(result.current).toBeNull()

    api.getStoreAppStatus.mockReturnValue(answer({ open: false }))
    rerender({ id: 'storeA' })
    await flush()
    expect(result.current.open).toBe(false)

    api.getStoreAppStatus.mockReturnValue(new Promise(() => {})) // store B has not answered yet
    rerender({ id: 'storeB' })
    expect(result.current).toBeNull()
  })

  it('stops asking when the cart page goes away', async () => {
    api.getStoreAppStatus.mockReturnValue(answer({ open: true }))
    const { unmount } = renderHook(() => useStoreAppStatus('store1'))
    await flush()
    unmount()
    const calls = api.getStoreAppStatus.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(APP_STATUS_REFRESH_MS * 5)
    })
    expect(api.getStoreAppStatus.mock.calls.length).toBe(calls)
  })
})
