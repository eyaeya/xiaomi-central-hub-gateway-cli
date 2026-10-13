# Third-party notices

## Do1e/mijia-api

The native Xiaomi Home cloud integration in `packages/core/src/cloud/` adapts
the HTTP API, authentication, resource, and wire-protocol behavior of
[Do1e/mijia-api](https://github.com/Do1e/mijia-api), version 5.0.0, inspected at
commit `2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1`.

- Upstream author: Do1e and upstream contributors.
- Upstream license: `GPL-3.0-or-later`, as declared in
  [pyproject.toml](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/pyproject.toml).
- Upstream license text:
  [LICENSE](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/LICENSE).
- Referenced implementation: `mijiaAPI/apis.py`, `devices.py`, and `miutils.py`.
- xgg changes: native TypeScript implementation using Node.js standard
  libraries and existing zod validation, separate cloud/gateway sessions,
  secret-safe summaries, CLI commands, mutation checkpoints, and test seams.

The public xgg core and CLI packages are distributed under
`GPL-3.0-or-later`; the GNU GPL license text accompanies those packages.
No Python runtime or new runtime dependency is introduced by this adaptation.

## micloud / Sammy Svensson

The upstream `miutils.py` credits the MIT-licensed
[micloud implementation](https://github.com/Squachen/micloud/blob/master/micloud/miutils.py)
by Sammy Svensson. The cloud nonce, signing, and RC4 protocol adaptation retains
that attribution. The following notice reproduces the
[upstream MIT license](https://github.com/Squachen/micloud/blob/master/LICENSE).

```text
MIT License

Copyright (c) 2020 Sammy Svensson

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
```
