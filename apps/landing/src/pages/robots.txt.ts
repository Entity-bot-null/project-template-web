import type { APIRoute } from 'astro';
import { robotsTxt } from '../lib/robots';

// Built once into dist/robots.txt, with the absolute sitemap address of the
// site the build was made for (astro.config.mjs, site).
export const GET: APIRoute = ({ site }) => {
  if (site === undefined) throw new Error('robots.txt needs the site address (astro.config.mjs).');
  return new Response(robotsTxt(site), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
