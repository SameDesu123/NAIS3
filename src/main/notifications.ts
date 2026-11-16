import { BrowserWindow, Notification } from 'electron'

/** Main owns OS delivery and the authoritative Electron window focus check. */
export function showNativeNotification(title: string, body: string): boolean {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isFocused() || !Notification.isSupported()) return false
  try {
    const notification = new Notification({ title, body, silent: true })
    notification.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    notification.show()
    return true
  } catch {
    return false
  }
}
