#!/bin/bash

MODEL=openrouter:google/gemini-2.5-flash
LOG=ingest.log

# Parse flags
YES=false
DEBUG=false
while getopts "yd" opt; do
  case $opt in
    y) YES=true ;;
    d) DEBUG=true ;;
    *) echo "Usage: $0 [-y] [-d] <codebase_path>" >&2; exit 1 ;;
  esac
done
shift $((OPTIND - 1))

CODEBASE_PATH="${1:?Usage: $0 [-y] [-d] <codebase_path>}"
DB=$CODEBASE_PATH/index.db

DEBUG_FLAGS=""
if $DEBUG; then
  DEBUG_FLAGS="--show-llm-requests --show-llm-responses"
fi

wait_for_enter() {
  if $YES; then
    return
  fi
  echo "$1, press enter to proceed"
  read
}

# Reset log file
> "$LOG"

rm -f $DB

./bin/run.js parse $CODEBASE_PATH -o $DB 2>&1 | tee -a "$LOG"
wait_for_enter "parsing done"

./bin/dev.js llm annotate --aspect purpose --aspect domain --aspect pure --model $MODEL -d $DB --batch-size 40 --max-iterations 80 $DEBUG_FLAGS 2>&1 | tee -a "$LOG"
wait_for_enter "annotate done"

./bin/dev.js llm modules --model $MODEL -d $DB $DEBUG_FLAGS 2>&1 | tee -a "$LOG"
wait_for_enter "modules done"

./bin/dev.js llm interactions -d $DB --verbose --force --model $MODEL $DEBUG_FLAGS 2>&1 | tee -a "$LOG"
wait_for_enter "interactions done"

./bin/dev.js llm flows -d $DB --verbose --force --model $MODEL $DEBUG_FLAGS 2>&1 | tee -a "$LOG"
wait_for_enter "flows done"

./bin/dev.js llm features -d $DB --verbose --force --model $MODEL $DEBUG_FLAGS 2>&1 | tee -a "$LOG"
