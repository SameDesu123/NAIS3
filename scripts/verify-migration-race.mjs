/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statfsSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// Replays what users did on v1.0.28: start the app on a large v18 workspace and, while that first
// start is still taking its pre-migration snapshot, launch it twice more at once.
//
// The first start migrates on its main thread, so it cannot answer the single-instance handshake.
// After 20 s each relaunch gives up on it, kills it and races the other for the lock (Chromium's
// ProcessSingleton). The loser is refused the lock while the winner is migrating.
//   fixed: a launch refused the lock must quit without touching the database
//   race:  the v1.0.28 startup code must show it interfering (control for the check itself)
// Chromium killing the first start happens in both. It is required, as proof that the run was
// slow enough to matter, and is not held against the fix.
// It seeds the app's real userData directory, so it only runs on CI.
const [expectation, platform = process.platform, arch = process.arch] = process.argv.slice(2)
assert.ok(['fixed', 'race'].includes(expectation), 'Usage: <fixed|race> [platform] [arch]')
assert.equal(process.env.CI, 'true', 'Overwrites the real NAIS3 userData directory; CI only')
assert.equal(platform, process.platform, 'Run the packaged app on its target OS')
assert.equal(arch, process.arch, 'Run the packaged app on its target architecture')

const TARGET_SECONDS = Number(process.env.RACE_TARGET_SECONDS ?? 45)
const TRIALS = Number(process.env.RACE_TRIALS ?? 3)
const MAX_BYTES = Number(process.env.RACE_MAX_GIB ?? 12) * 2 ** 30
const SETTLE_MS = 30_000
// The schema each user_version must have; anything else is a half-applied migration.
const INDEXES_BY_VERSION = {
  18: [],
  19: ['idx_images_file_path'],
  20: ['idx_images_file_path', 'idx_images_scene_favorite', 'idx_library_images_stack_order']
}

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
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 1_800_000 }
  )
  return JSON.parse(output.trim().split('\n').at(-1))
}

function launch(name, port) {
  const child = spawn(executable, [...guiArgs, `--remote-debugging-port=${port}`], {
    // A process group on POSIX, so the renderer and GPU helpers are stopped with the app.
    detached: platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  })
  const run = { name, port, child, started: Date.now(), output: '', exit: null, windowAt: null }
  child.stdout.on('data', (chunk) => (run.output += chunk))
  child.stderr.on('data', (chunk) => (run.output += chunk))
  run.exited = new Promise((done) =>
    child.on('exit', (code, signal) => done((run.exit = { code, signal, at: Date.now() })))
  )
  return run
}

async function stop(run) {
  if (platform === 'win32') {
    if (!run.exit) spawnSync('taskkill', ['/pid', String(run.child.pid), '/T', '/F'])
  } else {
    // The whole group, so the helpers of a start that Chromium killed go as well.
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
    // A migrating start accepts the connection but cannot answer until its main thread is free.
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1_000)
    })
    const targets = await response.json()
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
const gib = (bytes) => `${(bytes / 2 ** 30).toFixed(2)} GiB`
const tail = (run) => run.output.trim().split('\n').slice(-40).join('\n')
// What a relaunch does to a start that stopped answering: SIGKILL on POSIX, TerminateProcess
// with RESULT_CODE_HUNG (2) on Windows.
const killedByRelaunch = (run) =>
  run.exit !== null &&
  (run.exit.signal === 'SIGKILL' || (platform === 'win32' && run.exit.code === 2))

function describe(run, origin) {
  const events = []
  if (run.windowAt !== null) events.push(`window at ${seconds(run.windowAt - origin)}`)
  if (run.exit)
    events.push(
      `exited at ${seconds(run.exit.at - origin)} (${run.exit.signal ?? `code ${run.exit.code}`})`
    )
  if (!events.length) events.push('still running without a window')
  return `  ${run.name.padEnd(12)}${events.join(', ')}`
}

// 1. A fresh start shows which userData directory the packaged app really uses.
const probe = launch('probe', 9301)
const probeOpened = await waitFor(() => hasPage(9301), 120_000, probe)
await stop(probe)
assert.ok(probeOpened, `A fresh start never opened a window:\n${tail(probe)}`)
const userData = [join(appData, 'NAIS3'), join(appData, 'nais3')].find((dir) =>
  existsSync(join(dir, 'nais3.db'))
)
assert.ok(userData, `No nais3.db under ${appData}`)
const backups = join(userData, 'backups')
function clearWorkspace() {
  for (const name of readdirSync(userData))
    if (name.startsWith('nais3.db') || name === 'backups')
      rmSync(join(userData, name), { recursive: true, force: true })
}
clearWorkspace()

// 2. An existing v18 workspace whose images carry thumbnail BLOBs, sized for this runner. Leave
// room for the seed, the workspace and up to three snapshots of it.
const { bavail, bsize } = statfsSync(userData)
const free = bavail * bsize
const seedFile = join(userData, 'race-seed.db')
const seeded = dbTool('seed', migrations, seedFile, TARGET_SECONDS, Math.min(MAX_BYTES, free / 6))
assert.equal(seeded.version, 18)
const target = seeded.target
console.log(
  `Seeded ${userData}: v${seeded.version}, ${seeded.images} images, ${gib(seeded.bytes)} ` +
    `(${gib(free)} free). Snapshots run at ${(seeded.throughput / 2 ** 20).toFixed(0)} MiB/s, ` +
    `so one takes about ${seconds(seeded.expectedSeconds * 1000)}. The app migrates to v${target}.`
)
if (seeded.expectedSeconds < 30)
  console.log('Warning: not enough disk for a snapshot well past the 20 s timeout.')

// 3. Relaunch twice at once while the first start is inside its pre-migration snapshot.
async function trial(number) {
  clearWorkspace()
  copyFileSync(seedFile, join(userData, 'nais3.db'), constants.COPYFILE_FICLONE)
  const snapshots = new Map()
  const watchSnapshots = () => {
    if (!existsSync(backups)) return
    for (const name of readdirSync(backups))
      if (name.endsWith('.tmp') && !snapshots.has(name)) snapshots.set(name, Date.now())
  }

  const first = launch('first start', 9302)
  const snapshotting = await waitFor(() => (watchSnapshots(), snapshots.size > 0), 180_000, first)
  assert.ok(
    snapshotting,
    `Trial ${number}: the first start never began a snapshot:\n${tail(first)}`
  )
  const runs = [first, launch('relaunch 1', 9303), launch('relaunch 2', 9304)]
  const monitor = setInterval(watchSnapshots, 50)
  const deadline = Date.now() + Math.max(360, seeded.expectedSeconds * 8) * 1000
  let settleBy = Infinity
  while (Date.now() < Math.min(deadline, settleBy)) {
    for (const run of runs)
      if (!run.exit && run.windowAt === null && (await hasPage(run.port))) run.windowAt = Date.now()
    if (runs.every((run) => run.exit || run.windowAt !== null)) break
    // Once a window is up, give the other launches a little longer to leave.
    if (settleBy === Infinity && runs.some((run) => run.windowAt !== null))
      settleBy = Date.now() + SETTLE_MS
    await sleep(250)
  }
  clearInterval(monitor)
  watchSnapshots()
  const hanging = runs.filter((run) => !run.exit && run.windowAt === null)
  const killed = runs.filter(killedByRelaunch)
  const timeline = runs.map((run) => describe(run, first.started))
  await Promise.all(runs.map(stop))

  const result = dbTool('inspect', userData)
  const conclusive = first.windowAt === null && killed.includes(first)
  const signals = [
    [
      `only lock holders took snapshots (${snapshots.size} began; the first start and one takeover allowed)`,
      snapshots.size <= 2
    ],
    ['no launch was left running without a window (e.g. on an error dialog)', !hanging.length],
    [
      'every backup is pre-migration-v18.db holding v18',
      result.backups.every(
        (backup) => backup.name === 'pre-migration-v18.db' && backup.version === 18
      )
    ],
    [
      'no snapshot leftovers once the migration completed',
      result.version !== target || !result.leftovers.length
    ],
    [
      'the migration completed, unless every launch that took a snapshot was killed',
      result.version === target || killed.length >= snapshots.size
    ]
  ]
  const invariants = [
    ['database passes integrity_check', result.integrity === 'ok'],
    [
      `schema matches user_version ${result.version}`,
      JSON.stringify(result.indexes) === JSON.stringify(INDEXES_BY_VERSION[result.version])
    ],
    ['every backup passes quick_check', result.backups.every((backup) => backup.integrity === 'ok')]
  ]
  const raceFree = signals.every(([, ok]) => ok)
  const invariantsHold = invariants.every(([, ok]) => ok)
  const expected = conclusive && invariantsHold && (expectation === 'fixed' ? raceFree : !raceFree)

  const began = [...snapshots.values()].map((at) => seconds(at - first.started))
  console.log(`\nTrial ${number}/${TRIALS}\n${timeline.join('\n')}`)
  console.log(`  snapshots began at ${began.join(', ')}\n  ${JSON.stringify(result)}`)
  console.log(`${conclusive ? 'PASS' : 'FAIL'}  precondition: a relaunch killed the first start`)
  for (const [label, ok] of [...signals, ...invariants])
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!expected) for (const run of runs) console.log(`\n--- ${run.name} output ---\n${tail(run)}`)
  // A refused launch caught snapshotting or stuck, rather than only a leftover snapshot.
  const interfered = !signals[0][1] || !signals[1][1]
  return { conclusive, raceFree, invariantsHold, interfered }
}

const trials = []
for (let number = 1; number <= TRIALS; number++) trials.push(await trial(number))
clearWorkspace()
rmSync(seedFile, { force: true })
rmSync(work, { recursive: true, force: true })

const invariantsHold = trials.every((trial) => trial.invariantsHold)
const conclusive = trials.filter((trial) => trial.conclusive)
const reproduced = conclusive.filter((trial) => !trial.raceFree)
const interfered = reproduced.filter((trial) => trial.interfered)
console.log(
  `\n${conclusive.length}/${trials.length} trials were slow enough for a relaunch to kill the ` +
    `first start; ${reproduced.length} showed the race, ${interfered.length} of them with a ` +
    'refused launch interfering.'
)
const passed =
  invariantsHold &&
  (expectation === 'fixed'
    ? conclusive.length === trials.length && trials.every((trial) => trial.raceFree)
    : reproduced.length > 0)
if (passed)
  console.log(
    expectation === 'fixed'
      ? 'Launches refused the lock left the migration alone.'
      : 'The v1.0.28 control reproduced the race, and the database stayed intact.'
  )
else {
  console.error(
    !invariantsHold
      ? 'A database invariant broke.'
      : expectation === 'fixed' && conclusive.length < trials.length
        ? 'Some trials were too fast to reach the 20 s timeout; raise RACE_TARGET_SECONDS.'
        : expectation === 'fixed'
          ? 'A launch still interfered with the migration.'
          : 'The v1.0.28 control did not reproduce the race.'
  )
  process.exitCode = 1
}
