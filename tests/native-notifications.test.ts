import { beforeEach, describe, expect, it, vi } from 'vitest'
const { windowMock, supported, notificationMock, NativeNotification } = vi.hoisted(() => {
  const windowMock = {
    isFocused: vi.fn(),
    isMinimized: vi.fn(),
    isDestroyed: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn()
  }
  const supported = vi.fn()
  const notificationMock = { on: vi.fn(), show: vi.fn() }
  const NativeNotification = vi.fn(function () {
    return notificationMock
  })
  return { windowMock, supported, notificationMock, NativeNotification }
})
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [windowMock] },
  Notification: Object.assign(NativeNotification, { isSupported: supported })
}))
import { showNativeNotification } from '../src/main/notifications'

beforeEach(() => {
  vi.clearAllMocks()
  windowMock.isFocused.mockReturnValue(false)
  windowMock.isDestroyed.mockReturnValue(false)
  supported.mockReturnValue(true)
})

describe('native notification delivery', () => {
  it('suppresses OS delivery for a focused window or unsupported runtime', () => {
    windowMock.isFocused.mockReturnValue(true)
    expect(showNativeNotification('title', 'body')).toBe(false)
    windowMock.isFocused.mockReturnValue(false)
    supported.mockReturnValue(false)
    expect(showNativeNotification('title', 'body')).toBe(false)
    expect(NativeNotification).not.toHaveBeenCalled()
  })

  it('uses silent delivery and restores the app when the notification is clicked', () => {
    windowMock.isMinimized.mockReturnValue(true)
    expect(showNativeNotification('title', 'body')).toBe(true)
    expect(NativeNotification).toHaveBeenCalledWith({ title: 'title', body: 'body', silent: true })
    const click = notificationMock.on.mock.calls.find(([name]) => name === 'click')![1]
    click()
    expect(windowMock.restore).toHaveBeenCalledOnce()
    expect(windowMock.focus).toHaveBeenCalledOnce()
    windowMock.isDestroyed.mockReturnValue(true)
    click()
    expect(windowMock.focus).toHaveBeenCalledOnce()
  })

  it('allows in-app fallback when native delivery throws', () => {
    notificationMock.show.mockImplementationOnce(() => {
      throw new Error('Unavailable')
    })
    expect(showNativeNotification('title', 'body')).toBe(false)
  })
})
