// The dashboard on GitHub Pages calls this function from a different origin,
// so it needs CORS headers on every response, including the preflight OPTIONS
// request the browser sends first.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
