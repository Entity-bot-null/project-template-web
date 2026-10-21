// The product's name on the public site: the one place to rename it
// (docs/manual.md#22-rename-it-requiere-configuración).
export const SITE_NAME = 'Project template';

// The picture shown when a page of the site is shared (Open Graph): a PNG in
// public/, 1200 × 630 as social networks expect. Its texts are the name and
// the language codes, so one picture serves every language. Replace it with
// the product's own, at the same size (a spec checks it).
export const SHARE_IMAGE = { path: '/og.png', width: 1200, height: 630 } as const;
