/**
 * App versions and the identity they imply.
 *
 * A prerelease build (`1.0.30-beta.20261031.2`) runs as a separate app, NAIS3 Beta, so its
 * database migrations can never touch the stable app's workspace. The beta workflow builds
 * those with matching electron-builder overrides (.github/workflows/build.yml), and
 * scripts/verify-release.mjs checks the packaged result.
 */

export interface AppIdentity {
  /** Electron app name: userData folder, menu bar, default images folder */
  name: string
  /** Windows AppUserModelID and macOS bundle identifier */
  id: string
}

export const STABLE_IDENTITY: AppIdentity = { name: 'NAIS3', id: 'com.sunanakgo.nais3' }
export const BETA_IDENTITY: AppIdentity = { name: 'NAIS3 Beta', id: 'com.sunanakgo.nais3.beta' }

interface ParsedVersion {
  core: [number, number, number]
  pre: string[]
}

const VERSION =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(version: string): ParsedVersion | null {
  const m = VERSION.exec(version.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

export function isPrereleaseVersion(version: string): boolean {
  return (parseVersion(version)?.pre.length ?? 0) > 0
}

export function appIdentity(version: string): AppIdentity {
  return isPrereleaseVersion(version) ? BETA_IDENTITY : STABLE_IDENTITY
}

/** Semver precedence: negative when a < b. Unparsable versions sort below every valid one. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0)
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  // A release outranks its own prereleases: 1.0.30 > 1.0.30-beta.1
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return parseVersion(candidate) !== null && compareVersions(candidate, current) > 0
}

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

export interface GithubRelease {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  assets?: ReleaseAsset[]
}

/**
 * The release a Mac app should update to, or null.
 * A stable app only ever receives /releases/latest. A beta follows newer betas: a stable
 * release ships as NAIS3.app and would replace the NAIS3 Beta bundle with the stable
 * identity, and the next nightly beta already supersedes it.
 */
export function pickMacUpdate(
  releases: GithubRelease[],
  currentVersion: string,
  arch: string
): { version: string; asset: ReleaseAsset } | null {
  const beta = isPrereleaseVersion(currentVersion)
  let best: { version: string; asset: ReleaseAsset } | null = null
  for (const release of releases) {
    if (release.draft) continue
    const version = String(release.tag_name ?? '').replace(/^v/, '')
    if (isPrereleaseVersion(version) !== beta || !isNewerVersion(version, currentVersion)) continue
    if (best && compareVersions(version, best.version) <= 0) continue
    // 아키텍처에 맞는 mac zip (예: nais3-1.0.1-arm64-mac.zip)
    const asset = (release.assets ?? []).find((a) => a.name.endsWith(`${arch}-mac.zip`))
    if (asset) best = { version, asset }
  }
  return best
}

/** `owner/repo` from electron-builder's app-update.yml, which a beta build points at its own repository. */
export function repoFromUpdateConfig(yaml: string): string | null {
  const field = (key: string): string | undefined =>
    new RegExp(`^${key}:\\s*['"]?([A-Za-z0-9._-]+)['"]?\\s*$`, 'm').exec(yaml)?.[1]
  if (field('provider') !== 'github') return null
  const owner = field('owner')
  const repo = field('repo')
  return owner && repo ? `${owner}/${repo}` : null
}
