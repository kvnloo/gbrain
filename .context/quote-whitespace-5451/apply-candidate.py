"""Fork-only candidate preparation; not part of the eventual upstream diff."""
from pathlib import Path
import subprocess

path = Path('src/core/cycle/synthesize-verify.ts')
expected = '248f7ea39cc4869fd57da09ee411877fd957bb38'
actual = subprocess.check_output(['git', 'hash-object', str(path)], text=True).strip()
if actual != expected:
    raise SystemExit(f'Unreviewed source blob: {actual}; expected {expected}')
source = path.read_text(encoding='utf-8')
changes = [
    ('  let pendingSpace = false;\n', '  // Keep the first whitespace offset, not the preceding character.\n  let pendingSpace = -1;\n'),
    ('      pendingSpace = out.length > 0;\n', '      if (out.length > 0 && pendingSpace < 0) pendingSpace = i;\n'),
    ('    if (pendingSpace) {\n', '    if (pendingSpace >= 0) {\n'),
    ('      if (withMap) map.push(map.length > 0 ? map[map.length - 1] : i);\n', '      if (withMap) map.push(pendingSpace);\n'),
    ('      pendingSpace = false;\n', '      pendingSpace = -1;\n'),
]
for old, new in changes:
    if source.count(old) != 1:
        raise SystemExit(f'Expected one occurrence of {old!r}')
    source = source.replace(old, new)
path.write_text(source, encoding='utf-8')
