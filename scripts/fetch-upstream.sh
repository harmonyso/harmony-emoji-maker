#!/usr/bin/env bash
# Download the model files and the in-browser sampler from the Slack Moji Space, at one
# fixed commit, and build the folder that gets published.
#
#   bash scripts/fetch-upstream.sh            # fills _upstream/ (skipped if already there) and builds _site/
#
# To move to a newer upstream version, change REV, then run the tests.
set -euo pipefail

REV="8e8aecc55e855a51bb952c892efbef647c0ce372"
BASE="https://huggingface.co/spaces/cfahlgren1/slack-moji/resolve/${REV}"
UP="_upstream/${REV}"
SITE="_site"

# path in the Space | where it goes | exact size in bytes (empty = just not empty)
FILES=(
  "src/lib/client.js|lib/client.js|"
  "src/lib/engine.js|lib/engine.js|"
  "src/lib/tokenizer.js|lib/tokenizer.js|"
  "src/lib/worker.js|lib/worker.js|"
  "static/models/tessera_w8.onnx|models/tessera_w8.onnx|50840032"
  "static/models/clip_text_w8.onnx|models/clip_text_w8.onnx|64060515"
  "static/models/tokenizer.json|models/tokenizer.json|"
  "static/models/meta.json|models/meta.json|"
  "static/models/selftest.json|models/selftest.json|"
)

size_of() { wc -c < "$1" | tr -d ' '; }

for entry in "${FILES[@]}"; do
  IFS='|' read -r src dest want <<< "$entry"
  out="${UP}/${dest}"
  if [[ ! -s "$out" ]]; then
    mkdir -p "$(dirname "$out")"
    echo "downloading ${src}"
    curl --fail --location --silent --show-error --retry 4 --retry-delay 5 -o "${out}.part" "${BASE}/${src}"
    mv "${out}.part" "$out"
  fi
  got="$(size_of "$out")"
  if [[ -n "$want" && "$got" != "$want" ]]; then
    echo "error: ${dest} is ${got} bytes, expected ${want}" >&2
    rm -f "$out"
    exit 1
  fi
  if [[ "$got" == "0" ]]; then
    echo "error: ${dest} is empty" >&2
    exit 1
  fi
done

# The page is written against these exact names. Stop here if upstream ever changes them.
need() { grep -q -- "$2" "${UP}/$1" || { echo "error: $1 no longer contains: $2" >&2; exit 1; }; }
need lib/client.js 'export async function loadEngine(onProgress)'
need lib/client.js 'export function crashedLastTime()'
need lib/client.js 'export const GRID = 16;'
need lib/client.js 'generate(prompt, { n = 4, seed = 0, onStep } = {})'
need lib/client.js 'toRGBA(x, masked, b, maskColor'
need lib/client.js 'new URL("./worker.js", import.meta.url)'
need lib/worker.js 'from "./engine.js"'
need lib/engine.js 'from "./tokenizer.js"'
for f in tokenizer meta selftest; do
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${UP}/models/${f}.json" || { echo "error: models/${f}.json is not valid JSON" >&2; exit 1; }
done

rm -rf "$SITE"
mkdir -p "$SITE"
cp index.html style.css app.js backdrop.js people.js motion.js gif.js sheet.html sheet.js "$SITE/"
cp -r "${UP}/lib" "${UP}/models" "$SITE/"
touch "$SITE/.nojekyll"
echo "built ${SITE}/ from upstream ${REV:0:7}:"
du -sh "$SITE"
