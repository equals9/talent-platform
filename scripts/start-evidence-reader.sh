#!/bin/sh
set -eu
: "${CANDIDATE_OS_SOURCE_PATH:?Set the existing Candidate Intelligence checkout path}"
reader_python="${CANDIDATE_OS_READER_PYTHON:-$CANDIDATE_OS_SOURCE_PATH/.venv/bin/python}"
if [ ! -x "$reader_python" ]; then
  printf '%s\n' 'The configured existing source Python environment is unavailable.' >&2
  exit 1
fi
platform_directory=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$reader_python" "$platform_directory/bridges/candidate_os_read.py" "$@"
