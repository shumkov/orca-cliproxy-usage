# Provider mark attribution

The OpenAI Blossom (used for Codex) and Claude mark identify their respective services. OpenAI and its logo are trademarks of OpenAI; Claude and its mark are trademarks of Anthropic. These marks do not imply endorsement of this plugin.

`src/provider-marks.mjs` bundles unchanged SVG path geometry, viewBox and fill rules from Orca's `OpenAIIcon` and `ClaudeIcon` in [provider-icons.tsx](https://github.com/stablyai/orca/blob/6d5af64e39ab7c75c4b5f9f371f1fb7aa7a70634/src/renderer/src/components/status-bar/accounts/provider-icons.tsx). The paths also match installed Orca 1.4.258 native vectors. OpenAI follows the surrounding theme foreground; Claude retains the native #D97757 fill. No asset is fetched at runtime. See [OpenAI's brand guidelines](https://openai.com/brand/) for its mark attribution.

Upstream source: https://github.com/stablyai/orca, commit `6d5af64e39ab7c75c4b5f9f371f1fb7aa7a70634`.

## Orca source license

MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
