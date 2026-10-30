# Third-party notices

The UI and application code are original. No Prism/OpenAI source, logos or proprietary assets are used. React (MIT), Express (MIT), Drizzle ORM/Kit (Apache-2.0), Vite (MIT), Playwright (Apache-2.0), Wrangler (MIT/Apache-2.0) and cf (MIT/Apache-2.0) retain their licenses in their installed distributions.

The source editor uses **Monaco Editor 0.57.0**, Copyright (c) 2016 - present Microsoft Corporation, under the MIT license. Each production build distributes the full [MIT license](/licenses/monaco-LICENSE.txt) and upstream [third-party notices](/licenses/monaco-ThirdPartyNotices.txt), copied unchanged from the pinned npm package. Monaco's ESM code and text-editor worker are built and hosted with this application; no editor CDN or additional language-service workers are used. The LaTeX tokenizer and application theme are original.

The browser compiler is **SwiftLaTeX**, Copyright SwiftLab 2018-2022, AGPL-3.0, release `v20022022`. Its unmodified JS/WASM and corresponding source archive are in `public/compiler`, along with the full AGPL license and source links. `worker.js` is an original adapter restricting package lookup to local allowlisted static assets.

The format is from `SwiftLaTeX/Texlive-Ondemand`, commit `cc2146e220658f5ee0f8643355252ae0995fbc98`. Bundled TeX Live files were acquired from the Texlyre mirror during development. Their upstream licenses and source locations are in `public/compiler/NOTICE.txt`. Package/font files are unmodified; `pdftex.map` is a reduced mapping containing only shipped fonts. `assets.sha256.json` records distributed file hashes.

The added LaTeX base, tools, Babel and Hyperref files retain LPPL 1.3c+; `fullpage` retains LPPL; `titlesec` and `enumitem` retain MIT; the MarVoSym package retains OFL; Latin Modern fonts retain the GUST Font License; and `glyphtounicode.tex` retains the GNU GPL license of LCDF-typetools. The source and license links for each are listed in `public/compiler/NOTICE.txt`. The application/source archive and compiler source archive are downloadable from each deployment to satisfy source availability.
