/**
 * Decodificacion de entidades HTML, compartida por los conectores que leen
 * marcado en vez de una API.
 */

/**
 * Decodifica entidades HTML, incluidas las numericas.
 *
 * Se aplica dos veces por defecto porque algunas tiendas devuelven contenido
 * doblemente codificado: Marathon publica `&amp;apos;07` donde queria decir
 * `'07`, y una sola pasada lo dejaria en `&apos;07`.
 */
export function decodeEntities(input: string, passes = 2): string {
  let out = input;
  for (let i = 0; i < passes; i++) {
    const next = decodeOnce(out);
    if (next === out) break; // ya no queda nada por decodificar
    out = next;
  }
  return out;
}

function decodeOnce(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => safeChar(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeChar(parseInt(hex, 16)))
    // `&amp;` va al final: si fuera primero, `&amp;lt;` se volveria `<`
    // en una sola pasada en vez de `&lt;`, que es lo correcto.
    .replace(/&amp;/g, '&');
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}
