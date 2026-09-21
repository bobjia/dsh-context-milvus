import {
  exprEscapeString,
  normalizeFilterPath,
  toPosixPath,
  buildFilePathLike,
  buildFilePathEq,
} from '../src/path-normalize.js'

describe('exprEscapeString', () => {
  it('escapes backslashes and double quotes', () => {
    // JS literal 'C:\\ws\\proj' is the Windows path C:\ws\proj
    expect(exprEscapeString('C:\\ws\\proj')).toBe('C:\\\\ws\\\\proj')
    expect(exprEscapeString('a"b')).toBe('a\\"b')
  })

  it('leaves plain forward-slash paths untouched', () => {
    expect(exprEscapeString('/workspace/proj')).toBe('/workspace/proj')
  })
})

describe('normalizeFilterPath', () => {
  it('converts forward slashes to the injected separator', () => {
    expect(normalizeFilterPath('C:/ws/proj', '\\')).toBe('C:\\ws\\proj')
  })

  it('is a no-op when the separator matches', () => {
    expect(normalizeFilterPath('C:\\ws\\proj', '\\')).toBe('C:\\ws\\proj')
    expect(normalizeFilterPath('/workspace/proj', '/')).toBe('/workspace/proj')
  })
})

describe('toPosixPath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(toPosixPath('C:\\ws\\proj\\a.ts')).toBe('C:/ws/proj/a.ts')
  })

  it('is a no-op for posix paths', () => {
    expect(toPosixPath('/ws/proj/a.ts')).toBe('/ws/proj/a.ts')
  })
})

describe('buildFilePathLike', () => {
  it('emits an escaped prefix for a Windows path', () => {
    expect(buildFilePathLike('C:\\ws\\proj', '\\')).toBe('file_path like "C:\\\\ws\\\\proj%"')
  })

  it('accepts forward-slash input on a native-separator target', () => {
    expect(buildFilePathLike('C:/ws/proj', '\\')).toBe('file_path like "C:\\\\ws\\\\proj%"')
  })

  it('strips a trailing separator before the wildcard', () => {
    expect(buildFilePathLike('C:\\ws\\src\\', '\\')).toBe('file_path like "C:\\\\ws\\\\src%"')
  })

  it('keeps posix output byte-identical to the historical filter', () => {
    expect(buildFilePathLike('/workspace/proj', '/')).toBe('file_path like "/workspace/proj%"')
  })

  it('escapes a double quote in the prefix', () => {
    expect(buildFilePathLike('C:\\ws\\"x', '\\')).toBe('file_path like "C:\\\\ws\\\\\\"x%"')
  })
})

describe('buildFilePathEq', () => {
  it('emits an escaped exact-match filter', () => {
    expect(buildFilePathEq('C:\\repo\\a.ts')).toBe('file_path == "C:\\\\repo\\\\a.ts"')
  })

  it('keeps simple paths byte-identical to the historical filter', () => {
    expect(buildFilePathEq('src/test.ts')).toBe('file_path == "src/test.ts"')
  })
})
