# Harmony emoji maker

Describe an emoji and a tiny model paints four 16 × 16 pixel-art versions in your browser. Pick one and
download it as a 128 × 128 PNG, ready to add to Slack.

Nothing runs on a server. The model is downloaded once (about 115 MB) and runs on the visitor's own
device: on the graphics card through WebGPU where the browser has it, otherwise on the processor.

## Credits and license

- The model is [Tessera-small](https://huggingface.co/thejagstudio/tessera-small) by Jagrat Patel
  (TheJagStudio), trained on Angais' Pixel Art Atlas. License: CC BY-NC 4.0.
- The in-browser port (the ONNX model files, the sampler and the loader in `lib/`) comes from
  [Slack Moji](https://huggingface.co/spaces/cfahlgren1/slack-moji) by Caleb Fahlgren. License: CC BY-NC 4.0.
- The text encoder is OpenAI's CLIP ViT-B/32 (MIT).

Because of those licenses this project is for **non-commercial use only**, and it is shared under
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) too.

## How it is put together

| Part | Where it lives |
| --- | --- |
| The page | `index.html`, `style.css`, `app.js` in this repo |
| The sampler and loader | Not in this repo. Fetched from Slack Moji at a fixed commit into `lib/` when the site is built |
| The model files | Not in this repo. Fetched the same way into `models/` |

`scripts/fetch-upstream.sh` does the fetching. It pins one upstream commit, checks the model files are
exactly the expected size, checks the code still has the functions the page calls, and builds `_site/`.

Every push to `main` runs `.github/workflows/deploy.yml`, which builds the site, runs all the tests, and
publishes to GitHub Pages only if they pass.

## Tests

```
npm install
npx playwright install chromium

node tests/ui.test.mjs            # the page, with a stand-in for the model. Seconds.
bash scripts/fetch-upstream.sh    # downloads the real model, builds _site/
node tests/model.test.mjs _site   # the real model, on the processor. Minutes.
```

- `tests/ui.test.mjs` drives the page in a real browser: prompts, progress, picking, the downloaded
  PNG compared pixel by pixel, errors and retries, phone layout, keyboard use.
- `tests/model.test.mjs` checks the downloaded model against the reference output saved by its porter,
  then paints real emoji through the page and checks that the prompt steers the result.

Pictures from the test runs are saved in `tests/out/` and attached to each workflow run.

## Handy links

- `?cpu` runs on the processor even when a graphics card is available.
- `?seed=123` paints the same emoji again for the same prompt.
- `?n=1` paints one emoji instead of four.
