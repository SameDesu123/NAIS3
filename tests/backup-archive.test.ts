import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createNaisArchive, hasZipSignature, readNaisArchive } from '../src/main/backup/archive'
import { legacyNais3ToBackupDatabase } from '../src/main/backup/legacy'
import type { BackupDatabase } from '../src/main/backup/types'

function fixture(): BackupDatabase {
  return {
    version: 2,
    includedTables: ['character_folders', 'character_prompts', 'vibe_images'],
    tables: {
      character_folders: [{ id: 1, name: 'People', sort_order: 0, collapsed: 0, color: null }],
      character_prompts: [
        {
          id: 2,
          name: 'Alice',
          prompt: 'alice',
          negative_prompt: '',
          thumbnail: Buffer.from('thumbnail'),
          settings_json: '{}',
          sort_order: 0,
          created_at: '2026-08-24',
          updated_at: '2026-08-24',
          enabled: 1,
          center_x: 0.5,
          center_y: 0.5,
          folder_id: 1,
          folder: null
        }
      ],
      vibe_images: [
        {
          id: 3,
          name: 'Vibe',
          file_path: '/original/vibe.webp',
          thumbnail: null,
          enabled: 0,
          strength: 0.6,
          info_extracted: 0.7,
          encoded: null,
          encoded_ie: null,
          folder_id: null,
          sort_order: 0,
          created_at: '2026-08-24'
        }
      ]
    },
    mainParams: '{"prompt":"hello"}',
    files: [
      {
        table: 'vibe_images',
        rowId: 3,
        column: 'file_path',
        extension: '.webp',
        data: Buffer.from('webp-data')
      }
    ],
    missingFiles: []
  }
}

/** The same fixture with a second vibe whose source file was missing at export time. */
function fixtureWithMissingFile(): BackupDatabase {
  const database = fixture()
  database.tables.vibe_images!.push({
    ...database.tables.vibe_images![0],
    id: 4,
    name: 'Encoded vibe',
    file_path: '',
    encoded: 'paid encoding'
  })
  database.missingFiles = [{ table: 'vibe_images', rowId: 4, column: 'file_path' }]
  return database
}

async function editManifest(
  buffer: Buffer,
  change: (manifest: Record<string, unknown>) => void
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer)
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
  change(manifest)
  zip.file('manifest.json', JSON.stringify(manifest))
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('.nais backup archive', () => {
  it('round-trips split JSON, blobs, and file assets', async () => {
    const buffer = await createNaisArchive(fixture(), '1.0.23', '2026-08-24T00:00:00.000Z')
    expect(hasZipSignature(buffer)).toBe(true)

    const zip = await JSZip.loadAsync(buffer)
    expect(zip.file('manifest.json')).not.toBeNull()
    expect(zip.file('data/tables/character_prompts.json')).not.toBeNull()
    expect(zip.file('assets/files/vibe_images/3.webp')).not.toBeNull()

    const restored = await readNaisArchive(buffer)
    expect(restored.mainParams).toBe('{"prompt":"hello"}')
    expect(restored.tables.character_prompts?.[0].thumbnail).toEqual(Buffer.from('thumbnail'))
    expect(restored.files).toEqual([
      expect.objectContaining({
        table: 'vibe_images',
        rowId: 3,
        extension: '.webp',
        data: Buffer.from('webp-data')
      })
    ])
  })

  it('rejects an asset modified without updating its checksum', async () => {
    const zip = await JSZip.loadAsync(await createNaisArchive(fixture(), '1.0.23'))
    zip.file('assets/files/vibe_images/3.webp', Buffer.from('tampered'))
    const tampered = await zip.generateAsync({ type: 'nodebuffer' })

    await expect(readNaisArchive(tampered)).rejects.toThrow('checksum mismatch')
  })

  it('rejects unsupported archive versions', async () => {
    const archive = await editManifest(await createNaisArchive(fixture(), '1.0.23'), (manifest) => {
      manifest.formatVersion = 999
    })

    await expect(readNaisArchive(archive)).rejects.toThrow('Unsupported NAIS archive version')
  })

  it('writes format version 2, which older apps refuse before reading any table', async () => {
    const zip = await JSZip.loadAsync(await createNaisArchive(fixture(), '1.0.30'))
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))

    // 1.0.29 and earlier accept only formatVersion === 1
    expect(manifest.formatVersion).toBe(2)
    expect(manifest.missingFiles).toEqual([])
  })

  it('still reads version 1 archives', async () => {
    const archive = await editManifest(await createNaisArchive(fixture(), '1.0.23'), (manifest) => {
      manifest.formatVersion = 1
      delete manifest.missingFiles
    })

    const restored = await readNaisArchive(archive)
    expect(restored.version).toBe(1)
    expect(restored.missingFiles).toEqual([])
    expect(restored.files).toHaveLength(1)
  })

  it('keeps a row whose source file is missing and reports it', async () => {
    const buffer = await createNaisArchive(fixtureWithMissingFile(), '1.0.30')
    const zip = await JSZip.loadAsync(buffer)
    const assets = Object.values(zip.files).filter(
      (entry) => !entry.dir && entry.name.startsWith('assets/files/')
    )
    expect(assets.map((entry) => entry.name)).toEqual(['assets/files/vibe_images/3.webp'])

    const restored = await readNaisArchive(buffer)
    expect(restored.missingFiles).toEqual([{ table: 'vibe_images', rowId: 4, column: 'file_path' }])
    expect(restored.tables.vibe_images?.[1]).toEqual(
      expect.objectContaining({ id: 4, file_path: '', encoded: 'paid encoding' })
    )
    expect(restored.files.map((file) => file.rowId)).toEqual([3])
  })

  it('rejects inconsistent missing file lists', async () => {
    const created = await createNaisArchive(fixtureWithMissingFile(), '1.0.30')
    const cases: [string, (manifest: Record<string, unknown>) => void][] = [
      ['invalid missing file list', (manifest) => delete manifest.missingFiles],
      [
        'missing files in a version 1 archive',
        (manifest) => {
          manifest.formatVersion = 1
        }
      ],
      [
        'invalid missing file entry',
        (manifest) => {
          manifest.missingFiles = [{ table: 'character_prompts', rowId: 2, column: 'file_path' }]
        }
      ],
      [
        'lists a missing file twice',
        (manifest) => {
          manifest.missingFiles = [
            { table: 'vibe_images', rowId: 4, column: 'file_path' },
            { table: 'vibe_images', rowId: 4, column: 'file_path' }
          ]
        }
      ],
      [
        'lists a stored file as missing',
        (manifest) => {
          manifest.missingFiles = [
            { table: 'vibe_images', rowId: 3, column: 'file_path' },
            { table: 'vibe_images', rowId: 4, column: 'file_path' }
          ]
        }
      ]
    ]
    for (const [message, change] of cases) {
      await expect(readNaisArchive(await editManifest(created, change))).rejects.toThrow(message)
    }
  })

  it('normalizes the existing NAIS3 JSON format without touching newer tables', () => {
    const legacyTables = Object.fromEntries(
      [
        'character_folders',
        'character_prompts',
        'fragment_folders',
        'fragments',
        'vibe_folders',
        'vibe_images',
        'charref_folders',
        'charref_images',
        'scene_presets',
        'gen_scenes',
        'prompt_presets'
      ].map((table) => [table, []])
    )
    legacyTables.character_prompts = [
      { id: 1, name: 'Alice', thumbnail: { __blob: Buffer.from('thumb').toString('base64') } }
    ]
    legacyTables.vibe_images = [
      {
        id: 2,
        name: 'Vibe',
        file_path: '/old/vibe.webp',
        __image: Buffer.from('vibe').toString('base64')
      }
    ]

    const database = legacyNais3ToBackupDatabase({
      _app: 'NAIS3',
      _version: 1,
      mainParams: '{}',
      tables: legacyTables
    })

    expect(database.missingFiles).toEqual([])
    expect(database.includedTables).not.toContain('library_images')
    expect(database.tables.character_prompts?.[0].thumbnail).toEqual(Buffer.from('thumb'))
    expect(database.files[0]).toEqual(
      expect.objectContaining({ table: 'vibe_images', rowId: 2, data: Buffer.from('vibe') })
    )
  })

  it('keeps legacy JSON rows exported without their image', () => {
    const legacyTables: Record<string, unknown[]> = Object.fromEntries(
      [
        'character_folders',
        'character_prompts',
        'fragment_folders',
        'fragments',
        'vibe_folders',
        'vibe_images',
        'charref_folders',
        'charref_images',
        'scene_presets',
        'gen_scenes',
        'prompt_presets'
      ].map((table) => [table, []])
    )
    legacyTables.vibe_images = [
      { id: 5, name: 'Encoded vibe', file_path: '/gone/vibe.png', encoded: 'paid', __image: null }
    ]

    const database = legacyNais3ToBackupDatabase({
      _app: 'NAIS3',
      _version: 1,
      mainParams: null,
      tables: legacyTables
    })

    expect(database.tables.vibe_images).toEqual([
      { id: 5, name: 'Encoded vibe', file_path: '', encoded: 'paid' }
    ])
    expect(database.missingFiles).toEqual([{ table: 'vibe_images', rowId: 5, column: 'file_path' }])
    expect(database.files).toEqual([])
  })
})
