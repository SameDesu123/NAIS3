import { describe, expect, it } from 'vitest'
import {
  BETA_IDENTITY,
  STABLE_IDENTITY,
  appIdentity,
  compareVersions,
  isNewerVersion,
  isPrereleaseVersion,
  pickMacUpdate,
  repoFromUpdateConfig,
  type GithubRelease
} from '../src/shared/app-version'
import { releaseIdentity } from '../scripts/verify-release.mjs'

const beta = (date: string, run: number, base = '1.0.30'): string => `${base}-beta.${date}.${run}`

function release(tag: string, extra: Partial<GithubRelease> = {}): GithubRelease {
  const version = tag.replace(/^v/, '')
  return {
    tag_name: tag,
    prerelease: version.includes('-'),
    assets: ['arm64', 'x64'].map((arch) => ({
      name: `nais3-${version}-${arch}-mac.zip`,
      browser_download_url: `https://example.invalid/${version}-${arch}.zip`,
      size: 1
    })),
    ...extra
  }
}

describe('version comparison', () => {
  it('orders stable versions numerically instead of as text', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0)
    expect(compareVersions('1.1.0', '1.0.99')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0)
    expect(compareVersions('v1.0.29', '1.0.29')).toBe(0)
  })

  it('parses beta versions instead of treating them as NaN', () => {
    expect(isNewerVersion(beta('20261101', 3), beta('20261031', 2))).toBe(true)
    expect(isNewerVersion(beta('20261031', 10), beta('20261031', 9))).toBe(true)
    expect(isNewerVersion(beta('20261031', 2), beta('20261031', 2))).toBe(false)
    expect(isNewerVersion(beta('20261030', 7), beta('20261031', 2))).toBe(false)
    // The next patch's beta outranks the stable release it follows.
    expect(isNewerVersion(beta('20261031', 2), '1.0.29')).toBe(true)
  })

  it('ranks a release above its own prereleases', () => {
    expect(isNewerVersion('1.0.30', beta('20261031', 2))).toBe(true)
    expect(isNewerVersion(beta('20261231', 99), '1.0.30')).toBe(false)
    expect(compareVersions('1.0.30-beta.1', '1.0.30-beta.1.1')).toBeLessThan(0)
    expect(compareVersions('1.0.30-alpha', '1.0.30-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.30-beta.2', '1.0.30-beta.x')).toBeLessThan(0)
  })

  it('never reports an unparsable tag as newer', () => {
    for (const tag of ['', 'latest', '1.0', '1.0.30.1', 'v1.0.x', '01.0.30']) {
      expect(isNewerVersion(tag, '1.0.0')).toBe(false)
    }
  })
})

describe('app identity', () => {
  it('runs prereleases as NAIS3 Beta and leaves stable builds unchanged', () => {
    expect(appIdentity('1.0.29')).toBe(STABLE_IDENTITY)
    expect(STABLE_IDENTITY).toEqual({ name: 'NAIS3', id: 'com.sunanakgo.nais3' })
    expect(appIdentity(beta('20261031', 2))).toBe(BETA_IDENTITY)
    expect(BETA_IDENTITY.id).not.toBe(STABLE_IDENTITY.id)
    expect(BETA_IDENTITY.name).not.toBe(STABLE_IDENTITY.name)
    expect(isPrereleaseVersion('1.0.29+build.7')).toBe(false)
  })

  it('matches the names the release validator expects from the packaged build', () => {
    for (const version of ['1.0.29', beta('20261031', 2)]) {
      const runtime = appIdentity(version)
      const packaged = releaseIdentity(version)
      expect(packaged.productName).toBe(runtime.name)
      expect(packaged.appId).toBe(runtime.id)
      expect(packaged.macBundle).toBe(`${runtime.name}.app`)
    }
  })
})

describe('macOS update selection', () => {
  const current = beta('20261031', 2)

  it('picks the newest beta for the running architecture, whatever the list order', () => {
    const releases = [
      release(`v${beta('20261101', 3)}`),
      release(`v${beta('20261102', 4)}`),
      release(`v${current}`),
      release(`v${beta('20261030', 1)}`)
    ]
    const update = pickMacUpdate(releases, current, 'arm64')
    expect(update?.version).toBe(beta('20261102', 4))
    expect(update?.asset.name).toBe(`nais3-${beta('20261102', 4)}-arm64-mac.zip`)
    expect(pickMacUpdate(releases, current, 'x64')?.asset.name).toContain('-x64-mac.zip')
  })

  it('keeps a beta off stable releases, which ship under the stable identity', () => {
    expect(pickMacUpdate([release('v1.0.30'), release('v1.0.29')], current, 'arm64')).toBeNull()
    expect(
      pickMacUpdate([release('v1.0.30'), release(`v${beta('20261101', 3)}`)], current, 'arm64')
        ?.version
    ).toBe(beta('20261101', 3))
  })

  it('keeps a stable app on stable releases', () => {
    expect(pickMacUpdate([release('v1.0.30')], '1.0.29', 'arm64')?.version).toBe('1.0.30')
    expect(pickMacUpdate([release('v1.0.29')], '1.0.29', 'arm64')).toBeNull()
    expect(pickMacUpdate([release(`v${beta('20261101', 3)}`)], '1.0.29', 'arm64')).toBeNull()
  })

  it('skips drafts, releases without a matching ZIP, and malformed tags', () => {
    const newer = `v${beta('20261101', 3)}`
    expect(pickMacUpdate([release(newer, { draft: true })], current, 'arm64')).toBeNull()
    expect(pickMacUpdate([release(newer, { assets: [] })], current, 'arm64')).toBeNull()
    expect(pickMacUpdate([release(newer)], current, 'universal')).toBeNull()
    expect(
      pickMacUpdate([{ tag_name: undefined }, release('nightly')], current, 'arm64')
    ).toBeNull()
  })
})

describe('update repository from app-update.yml', () => {
  it('reads the repository electron-builder wrote for the build', () => {
    const config = [
      'owner: SameDesu123',
      'repo: NAIS3',
      'provider: github',
      'updaterCacheDirName: nais3-updater',
      ''
    ].join('\n')
    expect(repoFromUpdateConfig(config)).toBe('SameDesu123/NAIS3')
    expect(repoFromUpdateConfig('provider: \'github\'\nowner: "a.b-c"\nrepo: d_e\n')).toBe(
      'a.b-c/d_e'
    )
  })

  it('rejects other providers and incomplete or unsafe values', () => {
    expect(repoFromUpdateConfig('provider: generic\nowner: a\nrepo: b\n')).toBeNull()
    expect(repoFromUpdateConfig('provider: github\nowner: a\n')).toBeNull()
    expect(repoFromUpdateConfig('provider: github\nowner: a/../b\nrepo: c\n')).toBeNull()
    expect(repoFromUpdateConfig('')).toBeNull()
  })
})
