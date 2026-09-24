"""Fork-only candidate; edits only the disposable validation checkout."""
from pathlib import Path
import subprocess

path = Path('src/commands/extract-conversation-facts.ts')
expected = '78a8a719dbc368d5f3bb5cbe203944650bf5f4e2'
actual = subprocess.check_output(['git', 'hash-object', str(path)], text=True).strip()
if actual != expected:
    raise SystemExit(f'Unreviewed source blob: {actual}; expected {expected}')
original = path.read_text(encoding='utf-8')
source = original

# Bound every edit to the CLI wrapper; no core extraction, write or budget change.
marker = '// CLI parsing + handler.'
core = source.split(marker, 1)[0]
if marker not in source:
    raise SystemExit('CLI boundary missing')

def replace_once(old: str, new: str) -> None:
    global source
    if source.count(old) != 1:
        raise SystemExit(f'Expected one occurrence: {old!r}')
    source = source.replace(old, new, 1)

replace_once('  yes?: boolean;\n  help?: boolean;\n',
             '  yes?: boolean;\n  json?: boolean;\n  help?: boolean;\n')
replace_once("    if (a === '--dry-run') { out.dryRun = true; continue; }\n",
             "    if (a === '--json') { out.json = true; continue; }\n"
             "    if (a === '--dry-run') { out.dryRun = true; continue; }\n")
replace_once('  --help, -h             Show this help.\n',
             '  --json                 Emit one JSON summary for a foreground run.\n'
             '  --help, -h             Show this help.\n')

start_marker = '  const outcome = parsed.dryRun\n'
end_marker = '  // v0.41.15.0 (codex #3): exit 3'
if source.count(start_marker) != 1 or source.count(end_marker) != 1:
    raise SystemExit('Summary boundaries changed')
start = source.index(start_marker)
end = source.index(end_marker, start)
human_summary = source[start:end].rstrip('\n')
json_summary = '''  if (parsed.json) {
    console.log(JSON.stringify({
      schema_version: 1,
      ...aggregate,
      source_ids: sourceIds,
      dry_run: parsed.dryRun === true,
      spent_usd: totalSpent,
      budget_exhausted: anyBudgetExhausted,
    }));
  } else {
'''
source = source[:start] + json_summary + '\n'.join(
    '  ' + line if line else '' for line in human_summary.splitlines()
) + '\n  }\n\n' + source[end:]

if source.split(marker, 1)[0] != core:
    raise SystemExit('Candidate unexpectedly changes extraction core')
if source[source.index(end_marker):] != original[original.index(end_marker):]:
    raise SystemExit('Candidate unexpectedly changes exit status or helpers')
path.write_text(source, encoding='utf-8')
