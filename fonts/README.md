# fonts/

`FinSymbols.ttf` and `FinSymbols-Bold.ttf` are a symbols-only cut of
DejaVu Sans (currency signs, arrows, bullets, shapes — no letters), renamed as
the Bitstream Vera licence requires for a modified font. Licence:
`LICENSE-DejaVu.txt`.

Why: the PDF renderer (`api/render-pdf.ts`, @sparticuz/chromium) ships only
Open Sans, which has no ₦, ₵, → or ●. `api/_lib/pdf.ts` copies these files into
Chromium's font folder before each render, and the plan document names them
after Open Sans in every font stack, so the text stays Open Sans and only the
missing symbols come from here. Vercel bundles this folder through
`includeFiles` in `vercel.json`.

Regenerate (fonttools):

    pyftsubset DejaVuSans.ttf --unicodes="U+20A0-20CF,U+2190-21FF,U+2022,U+2023,U+2043,U+21D2,U+2212,U+2713,U+2714,U+2717,U+2718,U+25A0-25FF,U+2600-2610,U+2B05-2B07,U+2B24,U+2116,U+2122" --output-file=FinSymbols.ttf

then rename the family to "Fin Symbols" (name IDs 1, 3, 4, 6, 16).
