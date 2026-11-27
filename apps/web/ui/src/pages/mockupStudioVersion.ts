export function studioGenerationParam(generation: string): "generation_id" | "generation" {
  return /^(?:g0-legacy-original|g[1-9][0-9]*-|legacy-current-v2-)/.test(generation) ? "generation_id" : "generation";
}
