/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * 프롬프트 에디터 자동완성 수동 검증 (실제 Chromium) — CI에는 넣지 않는다.
 *
 * happy-dom으로는 textarea 네이티브 undo·selectionchange를 재현할 수 없어서
 * 브라우저 런타임(pnpm dev:web)을 띄운 상태에서 Playwright로 직접 키를 눌러 본다.
 *
 *   pnpm dev:web            # 다른 터미널 (http://127.0.0.1:5173)
 *   node scripts/verify-prompt-autocomplete.mjs [url]
 *
 * playwright는 의존성에 없다 — 전역/미리 설치된 것을 require로 찾는다.
 */
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const url = process.argv[2] ?? 'http://127.0.0.1:5173'
const POPUP = '[data-prompt-suggestions]'
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push([true, name])
  } catch (e) {
    results.push([false, `${name} — ${e.message}`])
  }
}
function expectEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto(url)
await page.locator('textarea').first().waitFor()
// 조각 시나리오용 — 브라우저 런타임 저장소에 조각을 하나 만들고 다시 로드해 스토어에 반영
// (새 브라우저 컨텍스트라 매 실행마다 빈 저장소에서 시작)
await page.evaluate(() =>
  window.nais.invoke('frags:create', { name: 'verify-style', folderId: null })
)
await page.reload()
const ta = page.locator('textarea').first()
await ta.waitFor()
// 회귀 시 남은 목록이 클릭을 가려 30초씩 매달리지 않게
page.setDefaultTimeout(5000)

const popup = page.locator(POPUP)
const items = popup.locator('button')
const value = () => ta.inputValue()

/** 비우고 새로 입력 — select all + Delete도 undo 기록에 남지만 각 시나리오는 독립 */
async function reset(text = '') {
  await ta.focus()
  await page.keyboard.press('Escape') // 이전 시나리오가 남긴 목록 정리
  await ta.click()
  await page.keyboard.press(`${mod}+A`)
  await page.keyboard.press('Delete')
  if (text) await page.keyboard.type(text, { delay: 20 })
}
async function popupOpen() {
  await popup.waitFor({ state: 'visible', timeout: 3000 })
}
async function popupClosed() {
  // 검색 debounce(90ms) + 응답 뒤에도 다시 열리지 않는지 넉넉히 확인
  await page.waitForTimeout(400)
  expectEq(await popup.count(), 0, '목록 닫힘')
}

await check('Tab 완성 후 Ctrl+Z → 완성 직전, 다시 Ctrl+Z → 그 전 입력', async () => {
  await reset('1girl')
  // 다른 편집 단위로 끊기 위해 커서를 움직였다가 돌아옴
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('End')
  await page.keyboard.type(', blue h', { delay: 20 })
  await popupOpen()
  const first = (await items.first().locator('span').first().textContent()).trim()
  await page.keyboard.press('Tab')
  expectEq(await value(), `1girl, ${first}, `, 'Tab 완성')
  await popupClosed()
  await page.keyboard.press(`${mod}+Z`)
  expectEq(await value(), '1girl, blue h', '첫 Ctrl+Z')
  await page.keyboard.press(`${mod}+Z`)
  const v = await value()
  if (!(v.length < '1girl, blue h'.length && '1girl, blue h'.startsWith(v))) {
    throw new Error(`두 번째 Ctrl+Z가 이전 입력을 되돌리지 못함: ${JSON.stringify(v)}`)
  }
})

await check('미선택 상태의 Enter → 줄바꿈 + 목록 닫힘', async () => {
  await reset('blue h')
  await popupOpen()
  await page.keyboard.press('Enter')
  expectEq(await value(), 'blue h\n', 'Enter')
  await popupClosed()
})

await check('↓로 고른 뒤 Enter → 그 항목 삽입', async () => {
  await reset('blue h')
  await popupOpen()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  const second = (await items.nth(1).locator('span').first().textContent()).trim()
  await page.keyboard.press('Enter')
  expectEq(await value(), `${second}, `, '↓↓ Enter')
})

await check('목록이 뜬 채 다른 곳을 클릭하면 목록 닫힘 (Tab도 삽입 안 함)', async () => {
  await reset('1girl, blue h')
  await popupOpen()
  const box = await ta.boundingBox()
  await page.mouse.click(box.x + 14, box.y + 14) // 첫 글자 앞쪽
  await popupClosed()
  const caret = await ta.evaluate((el) => el.selectionStart)
  if (caret >= 7) throw new Error(`클릭이 토큰 앞으로 커서를 옮기지 못함 (${caret})`)
  await page.keyboard.press('Tab')
  const v = await value()
  if (!v.endsWith('blue h')) throw new Error(`텍스트가 깨짐: ${JSON.stringify(v)}`)
})

await check('Home/←로 토큰을 벗어나면 목록 닫힘', async () => {
  await reset('1girl, blue h')
  await popupOpen()
  await page.keyboard.press('Home')
  await popupClosed()
  await reset('1girl, blue h')
  await popupOpen()
  await page.keyboard.press('ArrowLeft') // 토큰 안 — 유지
  await page.waitForTimeout(200)
  expectEq(await popup.count(), 1, '토큰 안 ← 후 목록 유지')
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft') // ", " 앞으로
  await popupClosed()
})

await check('범위 선택(Shift+← / 마우스 드래그)하면 목록 닫힘', async () => {
  await reset('1girl, blue h')
  await popupOpen()
  await page.keyboard.press('Shift+ArrowLeft')
  await popupClosed()
  await reset('1girl, blue h')
  await popupOpen()
  const box = await ta.boundingBox()
  await page.mouse.move(box.x + 14, box.y + 14)
  await page.mouse.down()
  await page.mouse.move(box.x + 60, box.y + 14, { steps: 5 })
  await page.mouse.up()
  await popupClosed()
})

await check('뒤에 쉼표가 있을 때 완성해도 목록이 다시 열리지 않음', async () => {
  await reset(', smile')
  await page.keyboard.press('Home')
  await page.keyboard.type('blue h', { delay: 20 })
  await popupOpen()
  const first = (await items.first().locator('span').first().textContent()).trim()
  await page.keyboard.press('Tab')
  expectEq(await value(), `${first}, smile`, '쉼표 앞 완성')
  await popupClosed()
})

await check('마우스를 올리면 선택이 따라가고 클릭으로 삽입', async () => {
  await reset('blue h')
  await popupOpen()
  const third = items.nth(2)
  const text = (await third.locator('span').first().textContent()).trim()
  await third.hover()
  const cls = await third.getAttribute('class')
  if (!cls.includes('bg-surface-2')) throw new Error('hover한 항목이 선택 표시되지 않음')
  await third.click()
  expectEq(await value(), `${text}, `, '클릭 삽입')
})

await check('조각(<) 자동완성 — 목록이 뜨면 Tab 완성 + Ctrl+Z', async () => {
  await reset('<verify')
  await popupOpen()
  const first = (await items.first().textContent()).trim() // "<path>"
  await page.keyboard.press('Tab')
  expectEq(await value(), `${first}, `, '조각 Tab 완성')
  await page.keyboard.press(`${mod}+Z`)
  expectEq(await value(), '<verify', '조각 Ctrl+Z')
})

await browser.close()
for (const [ok, name] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
process.exit(results.every(([ok]) => ok) ? 0 : 1)
