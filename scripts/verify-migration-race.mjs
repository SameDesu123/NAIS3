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

// Replays what users do on a large workspace after an update: start the app on a v18 workspace
// and, while that first start is still taking its pre-migration snapshot, launch it twice more.
//
// Chromium's ProcessSingleton gives a relaunch 20 s for the running app to answer; after that it
// kills the running app and takes over. Whether the first start answers depends on its main thread:
//   fixed:   migrating in a worker, it answers at once. Both relaunches hand over and quit, and the
//            first start finishes the upgrade with a single snapshot.
//   control: v1.0.29 migrates on the main thread, so a relaunch kills the first start (the bug).
// It seeds the app's real userData directory, so it only runs on CI.
const [expectation, platform = process.platform, arch = process.arch] = process.argv.slice(2)
assert.ok(['fixed', 'control'].includes(expectation), 'Usage: <fixed|control> [platform] [arch]')
assert.equal(process.env.CI, 'true', 'Overwrites the real NAIS3 userData directory; CI only')
assert.equal(platform, process.platform, 'Run the packaged app on its target OS')
assert.equal(arch, process.arch, 'Run the packaged app on its target architecture')

const TARGET_SECONDS = Number(process.env.RACE_TARGET_SECONDS ?? 45)
const TRIALS = Number(process.env.RACE_TRIALS ?? 3)
const MAX_BYTES = Number(process.env.RACE_MAX_GIB ?? 12) * 2 ** 30
const HANDOVER_MS = 15_000
const SINGLETON_TIMEOUT_MS = 20_000
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
  const run = {
    name,
    port,
    child,
    started: Date.now(),
    output: '',
    exit: null,
    windowAt: null,
    progressAt: null
  }
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

/** Records when the "Updating the database" page (a data: URL) and the main window appear. */
async function poll(run) {
  if (run.exit || run.windowAt !== null) return
  try {
    // A start blocked on its main thread accepts the connection but does not answer.
    const response = await fetch(`http://127.0.0.1:${run.port}/json/list`, {
      signal: AbortSignal.timeout(1_000)
    })
    const pages = (await response.json()).filter((target) => target.type === 'page')
    if (run.progressAt === null && pages.some((page) => page.url.startsWith('data:')))
      run.progressAt = Date.now()
    if (pages.some((page) => !page.url.startsWith('data:'))) run.windowAt = Date.now()
  } catch {
    // Not answering (yet).
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
const handedOver = (run) =>
  run.exit !== null &&
  run.exit.signal === null &&
  run.exit.code === 0 &&
  run.windowAt === null &&
  run.exit.at - run.started < HANDOVER_MS

function describe(run, origin) {
  const events = []
  if (run.progressAt !== null) events.push(`progress window at ${seconds(run.progressAt - origin)}`)
  if (run.windowAt !== null) events.push(`main window at ${seconds(run.windowAt - origin)}`)
  if (run.exit)
    events.push(
      `exited at ${seconds(run.exit.at - origin)} (${run.exit.signal ?? `code ${run.exit.code}`})`
    )
  if (!events.length) events.push('still running without a window')
  return `  ${run.name.padEnd(12)}${events.join(', ')}`
}

// 1. A fresh start shows which userData directory the packaged app really uses.
const probe = launch('probe', 9301)
const probeOpened = await waitFor(
  async () => (await poll(probe), probe.windowAt !== null),
  120_000,
  probe
)
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
// room for the seed, the workspace and a few snapshots of it.
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
  const relaunches = [launch('relaunch 1', 9303), launch('relaunch 2', 9304)]
  const runs = [first, ...relaunches]
  const monitor = setInterval(watchSnapshots, 50)
  const deadline = Date.now() + Math.max(360, seeded.expectedSeconds * 8) * 1000
  while (Date.now() < deadline) {
    await Promise.all(runs.map(poll))
    // The control has shown the bug once the first start is gone; whoever took over is not checked.
    if (expectation === 'control' && first.exit) break
    // Done once the first start is up or gone and no relaunch is still deciding.
    const firstSettled = first.exit !== null || first.windowAt !== null
    if (firstSettled && relaunches.every((run) => run.exit || run.windowAt !== null)) break
    await sleep(250)
  }
  clearInterval(monitor)
  watchSnapshots()
  const timeline = runs.map((run) => describe(run, first.started))
  await Promise.all(runs.map(stop))

  const result = dbTool('inspect', userData)
  // A relaunch only kills a start that has not answered for 20 s; the first start must still have
  // been migrating that long after the relaunches (or have been killed), or a pass proves nothing.
  const busyFor = (first.windowAt ?? first.exit?.at ?? Date.now()) - relaunches[0].started
  const conclusive = killedByRelaunch(first) || busyFor > SINGLETON_TIMEOUT_MS + 5_000
  const signals =
    expectation === 'fixed'
      ? [
          ['the first start was not killed and opened its main window', first.windowAt !== null],
          [
            `both relaunches handed over and quit with code 0 within ${seconds(HANDOVER_MS)}`,
            relaunches.every(handedOver)
          ],
          [
            'the first start showed its progress window and answered DevTools while migrating',
            first.progressAt !== null && first.progressAt < first.windowAt
          ],
          ['exactly one snapshot was taken', snapshots.size === 1],
          [
            `the migration completed to v${target} with a v18 backup and no leftovers`,
            result.version === target &&
              result.backups.length === 1 &&
              result.backups[0].name === 'pre-migration-v18.db' &&
              result.backups[0].version === 18 &&
              !result.leftovers.length
          ]
        ]
      : [['a relaunch killed the first start before it opened a window', killedByRelaunch(first)]]
  const invariants = [
    ['database passes integrity_check', result.integrity === 'ok'],
    [
      `schema matches user_version ${result.version}`,
      JSON.stringify(result.indexes) === JSON.stringify(INDEXES_BY_VERSION[result.version])
    ],
    ['every backup passes quick_check', result.backups.every((backup) => backup.integrity === 'ok')]
  ]
  const ok = conclusive && [...signals, ...invariants].every(([, passed]) => passed)

  const began = [...snapshots.values()].map((at) => seconds(at - first.started))
  console.log(`\nTrial ${number}/${TRIALS}\n${timeline.join('\n')}`)
  console.log(`  snapshots began at ${began.join(', ')}\n  ${JSON.stringify(result)}`)
  console.log(
    `${conclusive ? 'PASS' : 'FAIL'}  precondition: the first start was migrating for ` +
      `${seconds(busyFor)} after the relaunches (the timeout is ${seconds(SINGLETON_TIMEOUT_MS)})`
  )
  for (const [label, passed] of [...signals, ...invariants])
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) for (const run of runs) console.log(`\n--- ${run.name} output ---\n${tail(run)}`)
  return { ok, conclusive }
}

const trials = []
for (let number = 1; number <= TRIALS; number++) trials.push(await trial(number))
clearWorkspace()
rmSync(seedFile, { force: true })
rmSync(work, { recursive: true, force: true })

const passed = trials.filter((trial) => trial.ok).length
console.log(`\n${passed}/${trials.length} trials passed.`)
if (passed === trials.length)
  console.log(
    expectation === 'fixed'
      ? 'The migrating first start kept answering relaunches and finished the upgrade.'
      : 'The v1.0.29 control was killed mid-migration by a relaunch, as expected.'
  )
else {
  console.error(
    trials.some((trial) => !trial.conclusive)
      ? 'Some trials were too fast to reach the 20 s timeout; raise RACE_TARGET_SECONDS.'
      : expectation === 'fixed'
        ? 'A relaunch still interfered with the migrating first start.'
        : 'The v1.0.29 control did not reproduce the kill; the check cannot tell the fix apart.'
  )
  process.exitCode = 1
}
