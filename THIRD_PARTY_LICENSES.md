# Third-Party Licenses

This file reproduces the license notices for third-party software bundled in the Codex Gamebook Engine repository. The engine itself is released under the MIT License (see `LICENSE`).

---

## fengari-web.js

`fengari-web.js` at the root of this repository is a committed webpack build of [Fengari](https://fengari.io/) — a Lua 5.3 VM implemented in JavaScript. It is bundled as a static file rather than installed via npm because upstream Fengari does not actively cut releases; see the `package.json` `comments.fengari_pin_rationale` field for the full rationale. The bundled file preserves the upstream `@license MIT` annotation inline as a webpack-preserved comment header.

Fengari itself is distributed under the MIT License and carries forward the Lua PUC-Rio copyright from the reference Lua implementation it re-implements.

**Inline notice preserved in `fengari-web.js`:**

```
/**
@license MIT

Copyright © 2017-2019 Benoit Giannangeli
Copyright © 2017-2019 Daurnimator
Copyright © 1994–2017 Lua.org, PUC-Rio.
*/
```

**Full MIT License text (reproduced for completeness):**

> MIT License
>
> Copyright © 2017-2019 Benoit Giannangeli
> Copyright © 2017-2019 Daurnimator
> Copyright © 1994–2017 Lua.org, PUC-Rio.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Upstream project: <https://github.com/fengari-lua/fengari>
Upstream web build: <https://github.com/fengari-lua/fengari-web>

---

## fengari (Node)

The CLI emulator depends on the `fengari` npm package (pinned at `0.1.5` in `package.json`), which is the same Lua VM implementation distributed via npm. It is installed as a standard Node dependency at `node_modules/fengari/` and carries its own `LICENSE` file under that path at install time. The upstream copyrights and MIT License terms are identical to those reproduced above for `fengari-web.js`.

---

## Lua reference implementation

The Lua PUC-Rio copyright that appears in the Fengari notices reflects that Fengari is a JavaScript re-implementation of the Lua 5.3 reference implementation originally developed at the Pontifical Catholic University of Rio de Janeiro (PUC-Rio). The reference Lua implementation is itself distributed under the MIT License. Upstream project: <https://www.lua.org/>.
