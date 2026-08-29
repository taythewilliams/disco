/**
 * The join QR for the projector (D8).
 *
 * Shown during quiet moments — nothing playing, or the transport paused — so a
 * guest who has just walked in has somewhere to point their phone without
 * finding a printed poster in the dark.
 *
 * Rendered as an SVG path rather than a canvas or an image: it scales to any
 * projector without resampling, and it is a string, so React escapes nothing
 * dangerous into it. The encoded value is the join URL this page was served
 * from, which is never guest-supplied.
 */

import qrcode from 'qrcode-generator';

export interface QrPath {
  /** SVG path data for the dark modules. */
  d: string;
  /** Width and height of the untransformed grid, in modules. */
  size: number;
}

/**
 * Encode a URL as an SVG path.
 *
 * Error-correction level M rather than L: the projector surface is uneven, the
 * room is dark and phones read it from several metres away, and the extra
 * redundancy costs a slightly denser grid.
 */
export function qrPath(value: string): QrPath {
  // Type 0 asks the library to choose the smallest version that fits.
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();

  const size = qr.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`);
    }
  }
  return { d: parts.join(''), size };
}

/** The URL a guest should scan: this origin, without the display's own path. */
export function joinUrl(location: { origin: string }): string {
  return `${location.origin}/`;
}
