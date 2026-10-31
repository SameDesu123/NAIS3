import { app } from 'electron'
import { join } from 'path'
import { appIdentity, STABLE_IDENTITY } from '../shared/app-version'

// index.ts imports this first: userData must move before anything (including the single
// instance lock) uses it.
export const APP_IDENTITY = appIdentity(app.getVersion())

// 앱 이름 (dev 메뉴바·dock에서 'Electron' 대신 표시). 패키징 앱은 productName 사용
app.setName(APP_IDENTITY.name)

// A beta keeps its own workspace (database, backups, refs) so its migrations cannot strand
// the stable app's data. The stable app keeps Electron's default path.
if (APP_IDENTITY !== STABLE_IDENTITY) {
  app.setPath('userData', join(app.getPath('appData'), APP_IDENTITY.name))
}
