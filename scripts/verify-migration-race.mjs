/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// Launches the packaged app a second time while its first start is still migrating a large
// v18 workspace, then checks what both launches did to the database and its backups.
//   fixed: the second launch must leave without touching the database
//   race:  the v1.0.28 startup code must reproduce the race (control for the check itself)
// It seeds the app's real userData directory, so it only runs on CI.
const [expectation, platform = process.platform, arch = process.arch] = process.argv.slice(2)
assert.ok(['fixed', 'race'].includes(expectation), 'Usage: <fixed|race> [platform] [arch]')
assert.equal(process.env.CI, 'true', 'Overwrites the real NAIS3 userData directory; CI only')
assert.equal(platform, process.platform, 'Run the packaged app on its target OS')
assert.equal(arch, process.arch, 'Run the packaged app on its target architecture')

const IMAGES = Number(process.env.RACE_SEED_IMAGES ?? 60_000)
const THUMBNAIL_BYTES = Number(process.env.RACE_THUMBNAIL_BYTES ?? 24_576)
const SECOND_LAUNCH_LIMIT_MS = 30_000
const WINDOW_LIMIT_MS = 180_000

const directory = resolve(
  { win32: 'dist/win-unpacked', darwin: arch === 'arm64' ? 'dist/mac-arm64' : 'dist/mac' }[
    platform
  ] ?? 'dist/linux-unpacked'
)
const contents = platform === 'darwin' ? join(directory, 'NAIS3.app', 'Contents') : directory
const executable = {
  win32: join(contents, 'NAIS3.exe'),
  darwin: join(contents, 'MacOS', 'NAIS3'),
  linux: join(contents, 'nais3')
}[platform]
const sqlite = join(
  contents,
  platform === 'darwin' ? 'Resources' : 'resources',
  'app.asar',
  'node_modules',
  'better-sqlite3'
)
const appData = {
  win32: process.env.APPDATA,
  darwin: join(homedir(), 'Library', 'Application Support'),
  linux: process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}[platform]
// The unpacked Linux build has no setuid chrome-sandbox, and Ubuntu 24.04 blocks user namespaces.
const guiArgs = platform === 'linux' ? ['--no-sandbox'] : []

// esbuild is not a direct dependency, so pnpm does not link it at the top level. Use the copy
// electron-vite bundles the main process with.
const { buildSync } = createRequire(
  createRequire(import.meta.url).resolve('electron-vite/package.json')
)('esbuild')

const work = mkdtempSync(join(tmpdir(), 'nais3-race-'))
const migrations = join(work, 'migrations.cjs')
buildSync({
  entryPoints: ['src/main/db/migrations.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: migrations,
  logLevel: 'warning'
})

function dbTool(...args) {
  const output = execFileSync(
    executable,
    [
      resolve('scripts/verify-migration-race-db.mjs'),
      args[0],
      sqlite,
      ...args.slice(1).map(String)
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 900_000 }
  )
  return JSON.parse(output.trim().split('\n').at(-1))
}

function launch(name, args) {
  const started = Date.now()
  const child = spawn(executable, [...guiArgs, ...args], {
    // A process group on POSIX, so the renderer and GPU helpers are stopped with the app.
    detached: platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  })
  const run = { name, child, started, output: '', exit: null }
  child.stdout.on('data', (chunk) => (run.output += chunk))
  child.stderr.on('data', (chunk) => (run.output += chunk))
  run.exited = new Promise((done) =>
    child.on('exit', (code, signal) => done((run.exit = { code, signal, at: Date.now() })))
  )
  return run
}

async function stop(run) {
  if (run.exit) return
  if (platform === 'win32') spawnSync('taskkill', ['/pid', String(run.child.pid), '/T', '/F'])
  else {
    try {
      process.kill(-run.child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  await Promise.race([run.exited, sleep(15_000)])
}

async function hasPage(port) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return targets.some((target) => target.type === 'page')
  } catch {
    return false
  }
}

/** Polls until `condition` holds; false on timeout or when `run` exits first. */
async function waitFor(condition, limit, run) {
  const deadline = Date.now() + limit
  while (Date.now() < deadline) {
    if (await condition()) return true
    if (run?.exit) return false
    await sleep(100)
  }
  return false
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`
const tail = (run) => run.output.trim().split('\n').slice(-40).join('\n')

// 1. A fresh start shows which userData directory the packaged app really uses.
const probe = launch('probe', ['--remote-debugging-port=9301'])
const probeOpened = await waitFor(() => hasPage(9301), 120_000, probe)
await stop(probe)
assert.ok(probeOpened, `A fresh start never opened a window:\n${tail(probe)}`)
const userData = [join(appData, 'NAIS3'), join(appData, 'nais3')].find((dir) =>
  existsSync(join(dir, 'nais3.db'))
)
assert.ok(userData, `No nais3.db under ${appData}`)
for (const name of readdirSync(userData))
  if (name.startsWith('nais3.db') || name === 'backups')
    rmSync(join(userData, name), { recursive: true, force: true })

// 2. An existing v18 workspace whose images carry thumbnail BLOBs.
const seeded = dbTool('seed', migrations, join(userData, 'nais3.db'), IMAGES, THUMBNAIL_BYTES)
assert.equal(seeded.version, 18)
console.log(
  `Seeded ${userData}: v${seeded.version}, ${seeded.images} images, ` +
    `${(seeded.bytes / 2 ** 30).toFixed(2)} GiB (app migrates to v${seeded.target})`
)

// 3. Launch again as soon as the first start is inside its pre-migration snapshot.
const backups = join(userData, 'backups')
const snapshots = () =>
  existsSync(backups) ? readdirSync(backups).filter((name) => name.endsWith('.tmp')).length : 0
const first = launch('first', ['--remote-debugging-port=9302'])
const snapshotStarted = await waitFor(() => snapshots() > 0, 120_000, first)
assert.ok(snapshotStarted, `The first launch never started a snapshot:\n${tail(first)}`)
let concurrentSnapshots = 0
const monitor = setInterval(() => {
  concurrentSnapshots = Math.max(concurrentSnapshots, snapshots())
}, 50)
const second = launch('second', [])
await Promise.race([second.exited, sleep(SECOND_LAUNCH_LIMIT_MS)])
const firstOpened = await waitFor(() => hasPage(9302), WINDOW_LIMIT_MS, first)
const firstReadyAt = Date.now()
await sleep(2_000)
clearInterval(monitor)
const firstExitedEarly = first.exit
await stop(second)
await stop(first)

// 4. What the two launches left behind.
const result = dbTool('inspect', userData)
const backupNames = result.backups.map((backup) => backup.name)
const signals = [
  [
    'second launch exited by itself with code 0 within 30 s',
    second.exit !== null &&
      second.exit.code === 0 &&
      second.exit.at - second.started <= SECOND_LAUNCH_LIMIT_MS
  ],
  ['second launch took no snapshot of its own', concurrentSnapshots <= 1],
  ['first launch kept running and opened its window', firstOpened && !firstExitedEarly],
  ['backups contain only pre-migration-v18.db', backupNames.join() === 'pre-migration-v18.db'],
  ['pre-migration-v18.db holds the v18 database', result.backups[0]?.version === 18],
  ['no snapshot .tmp left behind', result.leftovers.length === 0]
]
const invariants = [
  ['database passes integrity_check', result.integrity === 'ok'],
  ['every backup passes quick_check', result.backups.every((backup) => backup.integrity === 'ok')]
]
if (expectation === 'fixed')
  invariants.push(
    [`database migrated to v${seeded.target}`, result.version === seeded.target],
    ['v19/v20 indexes present', result.indexes.length === 3]
  )

console.log(
  [
    `First launch: snapshot began, window ${firstOpened ? `after ${seconds(firstReadyAt - first.started)}` : 'never opened'}` +
      (firstExitedEarly ? `, exited early (code ${firstExitedEarly.code})` : ''),
    `Second launch: ${second.exit ? `exited after ${seconds(second.exit.at - second.started)} (code ${second.exit.code})` : 'still running, killed'}`,
    `Concurrent snapshots seen: ${concurrentSnapshots}`,
    `Result: ${JSON.stringify(result)}`
  ].join('\n')
)
for (const [label, ok] of [...signals, ...invariants])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)

const invariantsHold = invariants.every(([, ok]) => ok)
const raceFree = signals.every(([, ok]) => ok)
const passed = invariantsHold && (expectation === 'fixed' ? raceFree : !raceFree)
if (!passed) {
  for (const run of [first, second])
    console.log(`\n--- ${run.name} launch output ---\n${tail(run)}`)
  console.error(
    expectation === 'fixed'
      ? '\nThe second launch still interfered with the first start.'
      : invariantsHold
        ? '\nThe v1.0.28 control did not reproduce the race; raise RACE_SEED_IMAGES.'
        : '\nThe v1.0.28 control broke a database invariant.'
  )
  process.exitCode = 1
} else {
  console.log(
    expectation === 'fixed'
      ? '\nThe second launch left the migrating first start alone.'
      : '\nThe v1.0.28 control reproduced the race, and the database stayed intact.'
  )
}
rmSync(work, { recursive: true, force: true })
