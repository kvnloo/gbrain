"""Fork-only, hash-pinned candidates. Production edits stay in CI's checkout."""
from pathlib import Path
import subprocess
import sys

lane = sys.argv[1]
if lane not in {'mapless', 'numeric', 'combined', 'whitespace'}:
    raise SystemExit('Unknown lane')
p = Path('src/core/cycle/synthesize-verify.ts')
expected = '248f7ea39cc4869fd57da09ee411877fd957bb38'
actual = subprocess.check_output(['git', 'hash-object', str(p)], text=True).strip()
if actual != expected:
    raise SystemExit(f'Source drift: {actual}, expected {expected}')
original = p.read_text()
s = original
if lane != 'whitespace':
    Path('src/core/cycle/.wave1-baseline.ts').write_text(original)
if lane in {'mapless', 'combined'}:
    start = s.index('export function groundQuote(')
    end = s.index('\n/**', start)
    block = s[start:end]
    old = 'const q = normalizeForGrounding(inner);'
    if block.count(old) != 1 or 'q.map' in block:
        raise SystemExit('Unreviewed quote implementation')
    block = block.replace(old, 'const q = normForGrounding(inner);').replace('q.norm', 'q')
    s = s[:start] + block + s[end:]
if lane in {'numeric', 'combined'}:
    start = s.index('export function countUngroundedNumericClaims(')
    end = s.index('\n/**', start)
    block = s[start:end]
    old = 'for (const m of masked.match(claimRe) ?? []) {'
    if block.count(old) != 1 or block.count('normForGrounding(m)') != 1:
        raise SystemExit('Unreviewed numeric implementation')
    block = block.replace(old, 'for (const m of masked.matchAll(claimRe)) {')
    block = block.replace('normForGrounding(m)', 'normForGrounding(m[0])')
    s = s[:start] + block + s[end:]
if lane == 'whitespace':
    changes = [
        ('  let pendingSpace = false;\n', '  // Keep the first whitespace offset, not the preceding character.\n  let pendingSpace = -1;\n'),
        ('      pendingSpace = out.length > 0;\n', '      if (out.length > 0 && pendingSpace < 0) pendingSpace = i;\n'),
        ('    if (pendingSpace) {\n', '    if (pendingSpace >= 0) {\n'),
        ('      if (withMap) map.push(map.length > 0 ? map[map.length - 1] : i);\n', '      if (withMap) map.push(pendingSpace);\n'),
        ('      pendingSpace = false;\n', '      pendingSpace = -1;\n'),
    ]
    for old, new in changes:
        if s.count(old) != 1:
            raise SystemExit(f'Unexpected source shape: {old!r}')
        s = s.replace(old, new)
p.write_text(s)
