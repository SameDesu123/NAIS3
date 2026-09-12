import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { KO } from '../src/shared/i18n/catalog-ko'

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(path) ? [path] : []
  })
}

it('keeps literal translation calls on stable IDs with the correct positional arguments', () => {
  const errors: string[] = []
  for (const path of [...sources('src/main'), ...sources('src/renderer/src')]) {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['t', 'tr'].includes(node.expression.text)
      ) {
        const [id, ...args] = node.arguments
        if (id && ts.isStringLiteral(id)) {
          const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
          const message = KO[id.text as keyof typeof KO]
          if (message === undefined) errors.push(`${path}:${line}: unknown message ID ${id.text}`)
          else if (!args.some(ts.isSpreadElement)) {
            const indices = [...message.matchAll(/\{(\d+)[|}]/g)].map((match) => Number(match[1]))
            const required = indices.length ? Math.max(...indices) + 1 : 0
            if (args.length !== required)
              errors.push(`${path}:${line}: ${id.text} needs ${required} args, got ${args.length}`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  expect(errors).toEqual([])
})
