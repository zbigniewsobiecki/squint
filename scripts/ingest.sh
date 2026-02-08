#!/bin/bash

CODEBASE_PATH=/Users/zbigniew/Code/car-dealership
DB=$CODEBASE_PATH/index.db
MODEL=openrouter:google/gemini-2.5-flash

./bin/run.js parse $CODEBASE_PATH -o $DB
echo parsing done, press enter to proceed to annotate
read
./bin/dev.js llm annotate --aspect purpose --aspect domain --aspect pure --model $MODEL -d $DB --batch-size 40 --max-iterations 10
echo annotate done, press enter to proceed to modules
read
./bin/dev.js llm modules --model $MODEL -d $DB
echo modules done, press enter to proceed to interactions
read
./bin/dev.js llm interactions -d $DB --verbose --force --model $MODEL
echo interactions done, press enter to proceed to flows
read
./bin/dev.js llm flows -d $DB --verbose --force --model $MODEL
