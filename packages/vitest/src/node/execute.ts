import { builtinModules, createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'
import { basename, dirname, extname, join, resolve } from 'path'
import vm from 'vm'
import { readdirSync, existsSync } from 'fs'
import type { ModuleCache } from '../types'
import { slash } from '../utils'
import { spyOn } from '../integrations/jest-mock'
import { isValidNodeImport } from './mlly-port'

export type FetchFunction = (id: string) => Promise<string | undefined>

interface SuiteMocks {
  [suitePath: string]: {
    [originalPath: string]: string | null
  }
}

export interface ExecuteOptions {
  root: string
  files: string[]
  fetch: FetchFunction
  interpretDefault: boolean
  inline: (string | RegExp)[]
  external: (string | RegExp)[]
  moduleCache: Map<string, ModuleCache>
}

const defaultInline = [
  'vitest/dist',
  /virtual:/,
  /\.ts$/,
  /\/esm\/.*\.js$/,
  /\.(es|esm|esm-browser|esm-bundler|es6).js$/,
]
const depsExternal = [
  /\.cjs.js$/,
  /\.mjs$/,
]

const isWindows = process.platform === 'win32'

export const stubRequests: Record<string, any> = {
  '/@vite/client': {
    injectQuery: (id: string) => id,
    createHotContext() {
      return {
        accept: () => {},
        prune: () => {},
      }
    },
    updateStyle() {},
  },
}

export async function interpretedImport(path: string, interpretDefault: boolean) {
  const mod = await import(path)

  if (interpretDefault && '__esModule' in mod && 'default' in mod) {
    const defaultExport = mod.default
    if (!('default' in defaultExport)) {
      Object.defineProperty(defaultExport, 'default', {
        enumerable: true,
        configurable: true,
        get() { return defaultExport },
      })
    }
    return defaultExport
  }

  return mod
}

// vi.mock('../src/submodule') -> need to resovle to .ts file
// vi.mock('../src/submodule.ts') -> dont need to
const resolveModulePath = (suitePath: string, mockPath: string) => {
  // best case scenario
  const path = join(dirname(suitePath), mockPath)
  if (extname(path) !== '' && existsSync(path))
    return path

  const dir = dirname(path)
  const files = readdirSync(dir)
  const mockName = basename(mockPath)

  for (const file of files) {
    const [base] = file.split('.')
    if (base === mockName)
      return join(dir, file)
  }
  return null
}

const resolveMockPath = (mockPath: string) => {
  const dir = dirname(mockPath)
  const [baseId] = basename(mockPath).split('?')
  const fullPath = join(dir, '__mocks__', baseId)
  return existsSync(fullPath) ? fullPath : null
}

const getSuiteFromStack = (stack: string[]) => {
  return stack.find(path => basename(path).match(/\.(test|spec)\./))
}

const mockRegexp = /(?:vitest|vi).mock\(["'\s](.*[@\w_-]+)["'\s]\)/mg

export async function executeInViteNode(options: ExecuteOptions) {
  const { moduleCache, root, files, fetch } = options

  const mockedPaths: SuiteMocks = {}
  const externalCache = new Map<string, boolean>()
  builtinModules.forEach(m => externalCache.set(m, true))

  const result = []
  for (const file of files)
    result.push(await cachedRequest(`/@fs/${slash(resolve(file))}`, []))
  return result

  async function directRequest(id: string, fsPath: string, callstack: string[]) {
    callstack = [...callstack, id]
    const suite = getSuiteFromStack(callstack)
    const request = async(dep: string) => {
      const mocks = mockedPaths[suite || ''] || {}
      const mock = mocks[dep]
      if (mock)
        dep = mock
      if (callstack.includes(dep)) {
        const cacheKey = toFilePath(dep, root)
        if (!moduleCache.get(cacheKey)?.exports)
          throw new Error(`Circular dependency detected\nStack:\n${[...callstack, dep].reverse().map(p => `- ${p}`).join('\n')}`)
        return moduleCache.get(cacheKey)!.exports
      }
      return cachedRequest(dep, callstack)
    }

    if (id in stubRequests)
      return stubRequests[id]

    const transformed = await fetch(id)
    if (transformed == null)
      throw new Error(`failed to load ${id}`)

    // disambiguate the `<UNIT>:/` on windows: see nodejs/node#31710
    const url = pathToFileURL(fsPath).href
    const exports: any = {}

    setCache(fsPath, { code: transformed, exports })

    const __filename = fileURLToPath(url)
    const moduleProxy = {
      set exports(value) {
        exportAll(exports, value)
        exports.default = value
      },
      get exports() {
        return exports.default
      },
    }
    const context = {
      // esm transformed by Vite
      __vite_ssr_import__: request,
      __vite_ssr_dynamic_import__: request,
      __vite_ssr_exports__: exports,
      __vite_ssr_exportAll__: (obj: any) => exportAll(exports, obj),
      __vite_ssr_import_meta__: { url },
      // cjs compact
      require: createRequire(url),
      exports,
      module: moduleProxy,
      __filename,
      __dirname: dirname(__filename),
    }

    let match: RegExpExecArray | null

    // eslint-disable-next-line no-cond-assign
    while (match = mockRegexp.exec(transformed)) {
      const originalPath = resolveModulePath(id, match[1])
      if (originalPath) {
        const mockPath = resolveMockPath(originalPath)
        const mockInfo = {
          originalPath: originalPath.replace(root, ''),
          mockPath: mockPath?.replace(root, '') || null,
        }
        mockedPaths[id] ??= {}
        mockedPaths[id][mockInfo.originalPath] = mockInfo.mockPath
      }
    }

    const fn = vm.runInThisContext(`async (${Object.keys(context).join(',')})=>{${transformed}\n}`, {
      filename: fsPath,
      lineOffset: 0,
    })
    await fn(...Object.values(context))

    const mocks = suite ? mockedPaths[suite] : null
    if (mocks) {
      const mock = mocks[id]
      if (mock === null) {
        Object.entries(exports).forEach(([key, value]) => {
          if (typeof value === 'function')
            spyOn(exports, key)
        })
      }
    }

    return exports
  }

  function setCache(id: string, mod: Partial<ModuleCache>) {
    if (!moduleCache.has(id))
      moduleCache.set(id, mod)
    else
      Object.assign(moduleCache.get(id), mod)
  }

  async function cachedRequest(rawId: string, callstack: string[]) {
    const id = normalizeId(rawId)

    if (externalCache.get(id))
      return interpretedImport(id, options.interpretDefault)

    const fsPath = toFilePath(id, root)
    const importPath = patchWindowsImportPath(fsPath)

    if (!externalCache.has(importPath))
      externalCache.set(importPath, await shouldExternalize(importPath, options))

    if (externalCache.get(importPath))
      return interpretedImport(importPath, options.interpretDefault)

    if (moduleCache.get(fsPath)?.promise)
      return moduleCache.get(fsPath)?.promise
    const promise = directRequest(id, fsPath, callstack)
    setCache(fsPath, { promise })
    return await promise
  }

  function exportAll(exports: any, sourceModule: any) {
    // eslint-disable-next-line no-restricted-syntax
    for (const key in sourceModule) {
      if (key !== 'default') {
        try {
          Object.defineProperty(exports, key, {
            enumerable: true,
            configurable: true,
            get() { return sourceModule[key] },
          })
        }
        catch (_err) { }
      }
    }
  }
}

export function normalizeId(id: string): string {
  // Virtual modules start with `\0`
  if (id && id.startsWith('/@id/__x00__'))
    id = `\0${id.slice('/@id/__x00__'.length)}`
  if (id && id.startsWith('/@id/'))
    id = id.slice('/@id/'.length)
  if (id.startsWith('__vite-browser-external:'))
    id = id.slice('__vite-browser-external:'.length)
  if (id.startsWith('node:'))
    id = id.slice('node:'.length)
  return id
}

export async function shouldExternalize(id: string, config: Pick<ExecuteOptions, 'inline' | 'external'>) {
  if (matchExternalizePattern(id, config.inline))
    return false
  if (matchExternalizePattern(id, config.external))
    return true

  if (matchExternalizePattern(id, depsExternal))
    return true
  if (matchExternalizePattern(id, defaultInline))
    return false

  return id.includes('/node_modules/') && await isValidNodeImport(id)
}

export function toFilePath(id: string, root: string): string {
  let absolute = slash(id).startsWith('/@fs/')
    ? id.slice(4)
    : id.startsWith(dirname(root))
      ? id
      : id.startsWith('/')
        ? slash(resolve(root, id.slice(1)))
        : id

  if (absolute.startsWith('//'))
    absolute = absolute.slice(1)

  // disambiguate the `<UNIT>:/` on windows: see nodejs/node#31710
  return isWindows && absolute.startsWith('/')
    ? fileURLToPath(pathToFileURL(absolute.slice(1)).href)
    : absolute
}

function matchExternalizePattern(id: string, patterns: (string | RegExp)[]) {
  for (const ex of patterns) {
    if (typeof ex === 'string') {
      if (id.includes(`/node_modules/${ex}/`))
        return true
    }
    else {
      if (ex.test(id))
        return true
    }
  }
  return false
}

function patchWindowsImportPath(path: string) {
  if (path.match(/^\w:\\/))
    return `file:///${slash(path)}`
  else
    return path
}
