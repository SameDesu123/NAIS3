import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createNaisArchive, hasZipSignature, readNaisArchive } from '../src/main/backup/archive'
import type { BackupDatabaseV1 } from '../src/main/backup/types'

function fixture(): BackupDatabaseV1 {
  return {
    version: 1,
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
    ]
  }
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
    const zip = await JSZip.loadAsync(await createNaisArchive(fixture(), '1.0.23'))
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    manifest.formatVersion = 999
    zip.file('manifest.json', JSON.stringify(manifest))

    await expect(readNaisArchive(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(
      'Unsupported NAIS archive version'
    )
  })
})
