/** Local KaTeX font metadata, loaded only when visible math requests bundled fonts. */
import type { FontFile } from './asset-urls.js';

const katex = (family: string, style: FontFile['style'], weight: string, file: string, url: () => URL): FontFile =>
  ({ family, style, weight, unicodeRange: null, display: 'block', path: `math/fonts/${file}`, url });

export const KATEX_FONT_FILES: readonly FontFile[] = Object.freeze([
  katex('KaTeX_AMS', 'normal', '400', 'KaTeX_AMS-Regular.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_AMS-Regular.woff2', import.meta.url)),
  katex('KaTeX_Caligraphic', 'normal', '700', 'KaTeX_Caligraphic-Bold.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2', import.meta.url)),
  katex('KaTeX_Caligraphic', 'normal', '400', 'KaTeX_Caligraphic-Regular.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2', import.meta.url)),
  katex('KaTeX_Fraktur', 'normal', '700', 'KaTeX_Fraktur-Bold.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Fraktur-Bold.woff2', import.meta.url)),
  katex('KaTeX_Fraktur', 'normal', '400', 'KaTeX_Fraktur-Regular.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Fraktur-Regular.woff2', import.meta.url)),
  katex('KaTeX_Main', 'normal', '700', 'KaTeX_Main-Bold.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Main-Bold.woff2', import.meta.url)),
  katex('KaTeX_Main', 'italic', '700', 'KaTeX_Main-BoldItalic.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Main-BoldItalic.woff2', import.meta.url)),
  katex('KaTeX_Main', 'italic', '400', 'KaTeX_Main-Italic.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Main-Italic.woff2', import.meta.url)),
  katex('KaTeX_Main', 'normal', '400', 'KaTeX_Main-Regular.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2', import.meta.url)),
  katex('KaTeX_Math', 'italic', '700', 'KaTeX_Math-BoldItalic.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Math-BoldItalic.woff2', import.meta.url)),
  katex('KaTeX_Math', 'italic', '400', 'KaTeX_Math-Italic.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Math-Italic.woff2', import.meta.url)),
  katex('KaTeX_SansSerif', 'normal', '700', 'KaTeX_SansSerif-Bold.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_SansSerif-Bold.woff2', import.meta.url)),
  katex('KaTeX_SansSerif', 'italic', '400', 'KaTeX_SansSerif-Italic.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_SansSerif-Italic.woff2', import.meta.url)),
  katex('KaTeX_SansSerif', 'normal', '400', 'KaTeX_SansSerif-Regular.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_SansSerif-Regular.woff2', import.meta.url)),
  katex('KaTeX_Script', 'normal', '400', 'KaTeX_Script-Regular.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Script-Regular.woff2', import.meta.url)),
  katex('KaTeX_Size1', 'normal', '400', 'KaTeX_Size1-Regular.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Size1-Regular.woff2', import.meta.url)),
  katex('KaTeX_Size2', 'normal', '400', 'KaTeX_Size2-Regular.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Size2-Regular.woff2', import.meta.url)),
  katex('KaTeX_Size3', 'normal', '400', 'KaTeX_Size3-Regular.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Size3-Regular.woff2', import.meta.url)),
  katex('KaTeX_Size4', 'normal', '400', 'KaTeX_Size4-Regular.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Size4-Regular.woff2', import.meta.url)),
  katex('KaTeX_Typewriter', 'normal', '400', 'KaTeX_Typewriter-Regular.woff2', () => new URL('../../../../node_modules/katex/dist/fonts/KaTeX_Typewriter-Regular.woff2', import.meta.url)),
]);

